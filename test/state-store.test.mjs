import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { StateStore } from "../src/state-store.mjs";

function createDelivery(store, id, ownerSessionId = "session-a") {
  return store.createDeliveryRun({ id, ownerPid: 4242, ownerSessionId });
}

test("state store claims, transitions and records usage", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-swarm-store-"));
  const store = new StateStore(join(dir, "state.sqlite"));
  try {
    store.createTask({ id: "task-1", role: "planner", title: "Plan", prompt: "Plan safely", tokenBudget: 100, maxAttempts: 1 });
    const claimed = store.claimNext();
    assert.equal(claimed.status, "preparing");
    store.transition("task-1", "running");
    store.setThread("task-1", { threadId: "thr-1", turnId: "turn-1" });
    store.setTokenUsage("task-1", 42);
    assert.equal(store.getTask("task-1").tokenUsed, 42);
    assert.equal(store.getTask("task-1").tokenUsageSource, "turn_last");
    store.transition("task-1", "done");
    assert.equal(store.getTask("task-1").status, "done");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("state store does not claim a task before its dependencies finish", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-swarm-dependencies-"));
  const store = new StateStore(join(dir, "state.sqlite"));
  try {
    store.createTask({ id: "first", role: "planner", title: "First", prompt: "First", tokenBudget: 100, maxAttempts: 1 });
    store.createTask({ id: "second", role: "backend", title: "Second", prompt: "Second", dependencies: ["first"], tokenBudget: 100, maxAttempts: 1 });
    assert.equal(store.claimNext().id, "first");
    store.transition("first", "running");
    store.transition("first", "done");
    assert.equal(store.claimNext().id, "second");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SQLite lifecycle and external-action idempotency survive a restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-swarm-restart-")); const path = join(dir, "state.sqlite");
  let store = new StateStore(path);
  try {
    store.recordEvent(null, "lifecycle/turn started", { taskId: "task-a" });
    for (let index = 0; index < 150; index += 1) store.recordEvent(null, "lifecycle/item completed", { index });
    assert.equal(store.recordExternalAction({ idempotencyKey: "push:origin:candidate", kind: "remote-push", status: "started", payload: { branch: "swarm/candidate/a" } }).duplicate, false);
    assert.equal(store.recordExternalAction({ idempotencyKey: "push:origin:candidate", kind: "remote-push", status: "started" }).duplicate, true);
    store.updateExternalAction("push:origin:candidate", { status: "passed", payload: { sha: "a".repeat(40) } });
    store.close(); store = new StateStore(path);
    assert.equal(store.externalAction("push:origin:candidate").status, "passed");
    assert.equal(store.events({ after: 0, limit: 500 }).length >= 153, true, "bounded in-memory traces cannot erase persisted lifecycle history");
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("legacy aggregate token rows remain historical evidence but cannot block new local budget reservations", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-swarm-legacy-")); const store = new StateStore(join(dir, "state.sqlite"));
  try {
    store.createTask({ id: "legacy", role: "planner", title: "Legacy", prompt: "Legacy", tokenBudget: 100, maxAttempts: 1 });
    store.db.prepare("UPDATE tasks SET token_used = 999999, token_usage_source = NULL WHERE id = 'legacy'").run();
    store.createTask({ id: "measured", role: "planner", title: "Measured", prompt: "Measured", tokenBudget: 100, maxAttempts: 1 });
    store.setTokenUsage("measured", 42, { source: "turn_last" });
    const usage = store.weeklyUsageSince("2000-01-01T00:00:00.000Z");
    assert.equal(usage.used, 42);
    assert.equal(store.getTask("legacy").tokenUsed, 999999, "audit history remains untouched");
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("read-only StateStore reads an active runtime without schema writes", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-swarm-readonly-")); const path = join(dir, "state.sqlite");
  const writer = new StateStore(path); let reader;
  try {
    writer.createTask({ id: "task", role: "planner", title: "Plan", prompt: "Plan", tokenBudget: 10, maxAttempts: 1 });
    reader = new StateStore(path, { readOnly: true });
    assert.equal(reader.getTask("task").title, "Plan");
  } finally { reader?.close(); writer.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("read-only status remains available for a pre-migration runtime database", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-swarm-legacy-readonly-")); const path = join(dir, "state.sqlite");
  const legacy = new DatabaseSync(path); let reader;
  try {
    legacy.exec(`CREATE TABLE tasks (
      id TEXT PRIMARY KEY, token_used INTEGER NOT NULL DEFAULT 0,
      estimated_tokens INTEGER NOT NULL DEFAULT 0, token_budget INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL, created_at TEXT NOT NULL
    )`);
    legacy.prepare("INSERT INTO tasks(id, token_used, estimated_tokens, token_budget, status, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("old", 120550, 0, 0, "interrupted", "2026-01-01T00:00:00.000Z");
    legacy.close();
    reader = new StateStore(path, { readOnly: true });
    assert.equal(reader.weeklyUsageSince("2000-01-01T00:00:00.000Z").used, 0);
  } finally { reader?.close(); try { legacy.close(); } catch {} rmSync(dir, { recursive: true, force: true }); }
});

test("delivery lease is compare-and-set and preserves a fresh owner", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-swarm-delivery-lease-")); const store = new StateStore(join(dir, "state.sqlite"));
  try {
    createDelivery(store, "run-a", "session-a");
    assert.throws(() => store.claimDeliveryLease("run-a", { ownerPid: 5252, ownerSessionId: "session-b" }), /Delivery already owned/);
    const run = store.deliveryRun("run-a");
    assert.equal(run.ownerPid, 4242);
    assert.equal(run.ownerSessionId, "session-a");
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("atomic delivery creation records the initial lease and permits only one active run", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-swarm-delivery-create-")); const path = join(dir, "state.sqlite");
  const first = new StateStore(path); const second = new StateStore(path);
  try {
    const run = createDelivery(first, "run-a", "session-a");
    assert.equal(run.ownerSessionId, "session-a");
    assert.ok(run.heartbeatAt);
    assert.throws(() => createDelivery(second, "run-b", "session-b"), /Delivery already owned/);
    assert.equal(first.db.prepare("SELECT COUNT(*) AS count FROM delivery_runs WHERE state = 'running'").get().count, 1);
    assert.deepEqual(first.recoverStaleDeliveryRuns({ staleAfterMs: 60_000, isProcessAlive: (pid) => pid === 4242 }), []);
    first.updateDeliveryRun("run-a", { state: "failed" });
    const terminal = first.deliveryRun("run-a");
    assert.equal(terminal.ownerPid, null);
    assert.equal(terminal.ownerSessionId, null);
  } finally { second.close(); first.close(); rmSync(dir, { recursive: true, force: true }); }
});
