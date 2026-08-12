import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { StateStore } from "../src/state-store.mjs";
import { WorktreeManager, parseWorktreePorcelainZ } from "../src/worktree-manager.mjs";

const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
function repository() { const root = mkdtempSync(join(tmpdir(), "managed-worktree-")); git(root, ["init", "-b", "main"]); writeFileSync(join(root, "README.md"), "base\n"); git(root, ["add", "."]); git(root, ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "base"]); return root; }

test("v2 intent survives a pre-Git crash and reconciliation preserves it as missing", async () => {
  const root = repository(); const runtime = join(root, "runtime"); const store = new StateStore(join(runtime, "swarm.sqlite"));
  try {
    const manager = new WorktreeManager({ repository: root, runtimeDir: runtime, baseRef: "main", store }); const identity = await manager.repositoryIdentity(); const base = git(root, ["rev-parse", "HEAD"]);
    store.recordManagedWorktreeIntent({ recordId: "intent-only", kind: "worker", ...identity, intendedPath: join(runtime, "worktrees", "missing"), branch: "swarm/v2/worker/intent", intendedBaseSha: base, creationSessionId: "test-session" });
    await manager.reconcile(); const record = store.managedWorktree("intent-only");
    assert.equal(record.phase, "preserved"); assert.equal(record.classification, "missing");
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("v2 creation has collision-resistant identity and only clean prepared records are adoptable", async () => {
  const root = repository(); const runtime = join(root, "runtime"); const store = new StateStore(join(runtime, "swarm.sqlite"));
  try {
    const manager = new WorktreeManager({ repository: root, runtimeDir: runtime, baseRef: "main", store }); const base = git(root, ["rev-parse", "HEAD"]);
    const first = await manager.createManaged({ kind: "worker", taskId: "A/B", baseSha: base }); const second = await manager.createManaged({ kind: "worker", taskId: "A?B", baseSha: base });
    assert.notEqual(first.canonicalPath, second.canonicalPath); assert.notEqual(first.branch, second.branch);
    const adopted = await manager.adoptPreparedWorker({ id: "A/B", status: "preparing", artifactBaseSha: base, threadId: null, turnId: null });
    assert.equal(adopted.recordId, first.recordId);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("NUL worktree inventory parser preserves Unicode and does not line-split paths", () => {
  const items = parseWorktreePorcelainZ(Buffer.from("worktree C:/tmp/Робота with spaces\0HEAD abc\0branch refs/heads/swarm/v2/worker/x\0\0", "utf8"));
  assert.deepEqual(items, [{ path: "C:/tmp/Робота with spaces", head: "abc", branch: "swarm/v2/worker/x", bare: false }]);
});

test("read-only manager construction does not create runtime directories", () => {
  const root = repository(); const runtime = join(root, "absent-runtime");
  try { new WorktreeManager({ repository: root, runtimeDir: runtime, baseRef: "main", readOnly: true }); assert.equal(existsSync(runtime), false); }
  finally { rmSync(root, { recursive: true, force: true }); }
});

test("bidirectional inventory preserves Git-only managed-root and external registrations as observations", async () => {
  const root = repository(); const runtime = join(root, "runtime"); const outside = mkdtempSync(join(tmpdir(), "managed-external-")); const store = new StateStore(join(runtime, "swarm.sqlite"));
  try {
    const manager = new WorktreeManager({ repository: root, runtimeDir: runtime, baseRef: "main", store }); const base = git(root, ["rev-parse", "HEAD"]);
    const unmanaged = join(runtime, "worktrees", "git-only"); mkdirSync(join(runtime, "worktrees"), { recursive: true }); git(root, ["worktree", "add", "-b", "foreign/managed-root", unmanaged, base]);
    git(root, ["worktree", "add", "-b", "foreign/external", outside, base]);
    const result = await manager.reconcile();
    assert.equal(store.listManagedWorktrees().length, 0, "Git observations never become ownership records");
    assert.equal(result.observations.find((item) => item.path === unmanaged)?.classification, "unregistered-foreign-preserved");
    assert.equal(result.observations.find((item) => item.path === outside)?.classification, "foreign-legacy-observation");
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test("read-only inventory reports current missing records without SQLite or runtime writes", async () => {
  const root = repository(); const runtime = join(root, "runtime"); let store = new StateStore(join(runtime, "swarm.sqlite"));
  try {
    const manager = new WorktreeManager({ repository: root, runtimeDir: runtime, baseRef: "main", store }); const identity = await manager.repositoryIdentity(); const base = git(root, ["rev-parse", "HEAD"]);
    store.recordManagedWorktreeIntent({ recordId: "db-only", kind: "worker", ...identity, intendedPath: join(runtime, "worktrees", "absent"), branch: "swarm/v2/worker/db-only", intendedBaseSha: base, creationSessionId: "test-session" });
    store.close(); const before = statSync(join(runtime, "swarm.sqlite")).mtimeMs;
    store = new StateStore(join(runtime, "swarm.sqlite"), { readOnly: true }); const readonly = new WorktreeManager({ repository: root, runtimeDir: runtime, baseRef: "main", store, readOnly: true });
    const view = readonly.inventoryViewSync();
    assert.equal(view.current.get("db-only").classification, "missing"); assert.equal(statSync(join(runtime, "swarm.sqlite")).mtimeMs, before); assert.equal(existsSync(join(runtime, "integrations")), false);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
