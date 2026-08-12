import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { StateStore } from "../src/state-store.mjs";
import { WorktreeManager } from "../src/worktree-manager.mjs";
import { WorktreeFinalizer } from "../src/worktree-finalizer.mjs";
import { SwarmRouter } from "../src/router.mjs";
import { provider } from "./execution-provider-test-adapter.mjs";

const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const crash = (boundary) => () => { throw new Error(`test crash at ${boundary}`); };

function repository() {
  const root = mkdtempSync(join(tmpdir(), "p2-worktree-crash-"));
  git(root, ["init", "-b", "main"]);
  writeFileSync(join(root, "package.json"), JSON.stringify({ packageManager: "npm@10", scripts: { test: "node --test" } }));
  writeFileSync(join(root, "package-lock.json"), "{}");
  writeFileSync(join(root, "README.md"), "fixture\n");
  writeFileSync(join(root, "value.mjs"), "export const value = 1;\n");
  git(root, ["add", "."]); git(root, ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "base"]);
  return root;
}

function task(store, id = "writer") {
  return store.createTask({ id, role: "backend", title: id, prompt: "write safely", allowedPaths: ["value.mjs"], acceptanceChecks: [], dependencies: [], humanApprovalRequired: false, tokenBudget: 100, estimatedTokens: 10, maxAttempts: 1, riskFlags: [], supportingDomains: [], artifactDependencies: [], baselineBehaviorIds: [] });
}

function openManaged(root, hooks = {}) {
  const runtime = join(root, "runtime");
  const store = new StateStore(join(runtime, "swarm.sqlite"), { faultHooks: hooks });
  return { runtime, store, manager: new WorktreeManager({ repository: root, runtimeDir: runtime, baseRef: "main", store, faultHooks: hooks }) };
}

async function restartManaged(root) {
  const current = openManaged(root);
  const first = await current.manager.reconcile({ taskForRecord: (record) => record.taskId ? current.store.getTask(record.taskId) : null });
  const snapshot = current.store.listManagedWorktrees().map((record) => ({ recordId: record.recordId, phase: record.phase, classification: record.classification, taskId: record.taskId, canonicalPath: record.canonicalPath }));
  const count = (await current.manager.registeredWorktrees()).length;
  const second = await current.manager.reconcile({ taskForRecord: (record) => record.taskId ? current.store.getTask(record.taskId) : null });
  assert.deepEqual(current.store.listManagedWorktrees().map((record) => ({ recordId: record.recordId, phase: record.phase, classification: record.classification, taskId: record.taskId, canonicalPath: record.canonicalPath })), snapshot, "second reconciliation is idempotent");
  assert.equal((await current.manager.registeredWorktrees()).length, count, "reconciliation does not add a Git worktree");
  return { ...current, first, second, snapshot, count };
}

const roles = Object.fromEntries(["bootstrap", "planner", "backend", "frontend", "database", "qa", "security", "devops"].map((role) => [role, { sandbox: role === "backend" ? "workspace-write" : "read-only", approvalPolicy: "never", tokenBudget: 100, maxAttempts: 1, usesWorktree: role === "backend" }]));

class WriterClient extends EventEmitter {
  constructor() { super(); this.sequence = 0; this.threads = new Map(); }
  async connect() {}
  async shutdown() {}
  diagnostics() { return { protocolEvents: [], stderrTail: "", process: { alive: false } }; }
  async request(method) { return method === "account/read" ? { account: {} } : method === "account/usage/read" ? { dailyUsageBuckets: [] } : { rateLimits: null }; }
  async startThread({ cwd }) { const id = `thread-${++this.sequence}`; this.threads.set(id, { cwd, turnId: null }); return { thread: { id } }; }
  async setGoal() {}
  async startTurn({ threadId }) { const turnId = `turn-${threadId}`; this.threads.get(threadId).turnId = turnId; return { turn: { id: turnId } }; }
  async waitForTurn(threadId, turnId) { writeFileSync(join(this.threads.get(threadId).cwd, "value.mjs"), "export const value = 2;\n"); return { id: turnId, status: "completed" }; }
  async readThread({ threadId }) { const turnId = this.threads.get(threadId).turnId; return { thread: { turns: [{ id: turnId, items: [{ type: "agentMessage", text: "completed" }] }] } }; }
}

function routerConfig(root, faultHooks = {}) {
  return { repository: root, runtimeDir: join(root, "runtime"), baseRef: "main", model: "test", faultHooks, processRunner: async () => ({ pid: 1, stdout: "passed", stderr: "" }), project: { name: "p2", documentationDir: "docs/orchestration-input", generatedDir: "docs/orchestration-generated", productRoots: [] }, router: { maxConcurrentTasks: 1, maxChildrenPerTask: 5, maxDelegationDepth: 4, maxPlanTasks: 5, defaultParentBudget: 1000, turnTimeoutMs: 1000, approvalMode: "deny" }, budget: { weeklyTokenLimit: 10_000, weeklyWindowDays: 7 }, quota: { throttleAtUsedPercent: 90, throttleWhenUnavailable: false }, roles, executionProviderFactory: () => provider(new WriterClient()) };
}

async function crashedRouter(root, boundary) {
  const router = new SwarmRouter(routerConfig(root, { [boundary]: crash(boundary) }));
  await router.ensureProjectOverlay();
  const created = router.enqueue({ role: "backend", title: `crash ${boundary}`, prompt: "edit value", allowedPaths: ["value.mjs"] });
  await router.runUntilIdle();
  const taskState = router.store.getTask(created.id);
  const record = router.store.listManagedWorktrees().find((item) => item.taskId === created.id);
  assert.equal(taskState.status, "failed", "fault is treated as a discarded controller crash boundary");
  assert.ok(record, "worker ownership record is durable before finalization");
  const worktreeCount = (await router.worktrees.registeredWorktrees()).length;
  router.close();
  return { taskId: created.id, recordId: record.recordId, worktreeCount };
}

test("managed_worktree_intent_persisted restart preserves a missing intent without reusing its path", async () => {
  const root = repository(); let subject;
  try {
    subject = openManaged(root, { managed_worktree_intent_persisted: crash("managed_worktree_intent_persisted") }); task(subject.store);
    await assert.rejects(subject.manager.create("writer"), /managed_worktree_intent_persisted/);
    const intent = subject.store.listManagedWorktrees()[0]; const intended = intent.intendedPath;
    assert.equal(existsSync(intended), false); assert.equal((await subject.manager.registeredWorktrees()).length, 1);
    subject.store.close(); subject = null;
    const restarted = await restartManaged(root); const record = restarted.store.managedWorktree(intent.recordId);
    assert.deepEqual({ phase: record.phase, classification: record.classification }, { phase: "preserved", classification: "missing" });
    assert.equal(existsSync(intended), false); assert.equal(restarted.count, 1);
    restarted.store.close();
  } finally { subject?.store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("managed_worktree_git_created restart keeps the exact clean pre-turn record adoptable", async () => {
  const root = repository(); let subject; let restarted;
  try {
    subject = openManaged(root, { managed_worktree_git_created: crash("managed_worktree_git_created") }); task(subject.store);
    await assert.rejects(subject.manager.create("writer"), /managed_worktree_git_created/);
    const before = subject.store.listManagedWorktrees()[0]; const count = (await subject.manager.registeredWorktrees()).length; assert.equal(count, 2);
    subject.store.close(); subject = null;
    restarted = await restartManaged(root); const record = restarted.store.managedWorktree(before.recordId);
    assert.equal(record.phase, "linked"); assert.equal(record.classification, "active"); assert.equal(restarted.count, count);
    restarted.store.transition("writer", "preparing");
    const adopted = await restarted.manager.adoptPreparedWorker(restarted.store.getTask("writer"));
    assert.equal(adopted.recordId, before.recordId); assert.equal((await restarted.manager.registeredWorktrees()).length, count);
  } finally { subject?.store.close(); restarted?.store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("managed_worktree_record_linked_before_task_linkage rollback leaves no half-adoption", async () => {
  const root = repository(); let subject; let restarted;
  try {
    subject = openManaged(root, { managed_worktree_record_linked_before_task_linkage: crash("managed_worktree_record_linked_before_task_linkage") }); task(subject.store);
    await assert.rejects(subject.manager.create("writer"), /managed_worktree_record_linked_before_task_linkage/);
    const before = subject.store.listManagedWorktrees()[0]; assert.equal(subject.store.getTask("writer").worktree, null);
    subject.store.close(); subject = null;
    restarted = await restartManaged(root); const record = restarted.store.managedWorktree(before.recordId);
    assert.equal(record.phase, "git_created"); assert.equal(restarted.store.getTask("writer").worktree, null);
    restarted.store.transition("writer", "preparing");
    const adopted = await restarted.manager.adoptPreparedWorker(restarted.store.getTask("writer"));
    assert.equal(adopted.recordId, before.recordId); assert.equal(restarted.store.getTask("writer").worktree, adopted.canonicalPath);
  } finally { subject?.store.close(); restarted?.store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("managed_worktree_task_linked restart retains the atomically linked clean pre-turn record", async () => {
  const root = repository(); let subject; let restarted;
  try {
    subject = openManaged(root, { managed_worktree_task_linked: crash("managed_worktree_task_linked") }); task(subject.store);
    await assert.rejects(subject.manager.create("writer"), /managed_worktree_task_linked/);
    const before = subject.store.listManagedWorktrees()[0]; const linkedPath = subject.store.getTask("writer").worktree; assert.ok(linkedPath);
    subject.store.close(); subject = null;
    restarted = await restartManaged(root); const record = restarted.store.managedWorktree(before.recordId);
    assert.equal(record.phase, "linked"); assert.equal(restarted.store.getTask("writer").worktree, linkedPath);
    assert.equal((await restarted.manager.registeredWorktrees()).length, restarted.count);
  } finally { subject?.store.close(); restarted?.store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("finalizer_git_committed Router restart preserves a committed worker without an artifact", async () => {
  const root = repository(); let restarted;
  try {
    const crashed = await crashedRouter(root, "finalizer_git_committed");
    restarted = new SwarmRouter(routerConfig(root)); await restarted.recoverStaleDeliveries(); await restarted.recoverStaleDeliveries();
    const record = restarted.store.managedWorktree(crashed.recordId); assert.deepEqual({ phase: record.phase, classification: record.classification }, { phase: "linked", classification: "preserved-failure" });
    assert.equal(restarted.store.workerArtifact(crashed.taskId), null); assert.equal(existsSync(join(root, "docs", "orchestration-generated", "worker-artifacts", `${crashed.taskId}.v1.json`)), false);
    assert.equal((await restarted.worktrees.registeredWorktrees()).length, crashed.worktreeCount);
  } finally { restarted?.close(); rmSync(root, { recursive: true, force: true }); }
});

test("finalizer_artifact_file_written Router restart preserves file-only evidence and never publishes it", async () => {
  const root = repository(); let restarted;
  try {
    const crashed = await crashedRouter(root, "finalizer_artifact_file_written");
    assert.equal(existsSync(join(root, "docs", "orchestration-generated", "worker-artifacts", `${crashed.taskId}.v1.json`)), true);
    restarted = new SwarmRouter(routerConfig(root)); await restarted.recoverStaleDeliveries(); await restarted.recoverStaleDeliveries();
    const record = restarted.store.managedWorktree(crashed.recordId); assert.equal(record.phase, "linked"); assert.equal(record.classification, "preserved-failure");
    assert.equal(restarted.store.workerArtifact(crashed.taskId), null); assert.equal((await restarted.worktrees.registeredWorktrees()).length, crashed.worktreeCount);
  } finally { restarted?.close(); rmSync(root, { recursive: true, force: true }); }
});

test("artifact_file_before_db_persistence Router boundary does not promote a file into an artifact", async () => {
  const root = repository(); let restarted;
  try {
    const crashed = await crashedRouter(root, "artifact_file_before_db_persistence");
    restarted = new SwarmRouter(routerConfig(root)); await restarted.recoverStaleDeliveries(); await restarted.recoverStaleDeliveries();
    assert.equal(existsSync(join(root, "docs", "orchestration-generated", "worker-artifacts", `${crashed.taskId}.v1.json`)), true);
    assert.equal(restarted.store.workerArtifact(crashed.taskId), null); assert.equal(restarted.store.getTask(crashed.taskId).status, "failed");
    assert.equal((await restarted.worktrees.registeredWorktrees()).length, crashed.worktreeCount);
  } finally { restarted?.close(); rmSync(root, { recursive: true, force: true }); }
});

test("artifact_db_persisted_before_task_completion restart keeps lineage unusable until the task is correctly done", async () => {
  const root = repository(); let restarted;
  try {
    const crashed = await crashedRouter(root, "artifact_db_persisted_before_task_completion");
    restarted = new SwarmRouter(routerConfig(root)); await restarted.recoverStaleDeliveries(); await restarted.recoverStaleDeliveries();
    const artifact = restarted.store.workerArtifact(crashed.taskId); assert.ok(artifact?.headSha);
    assert.equal(restarted.store.getTask(crashed.taskId).status, "failed");
    await assert.rejects(restarted.integrateFinalized([crashed.taskId]), /must be done/);
    assert.equal((await restarted.worktrees.registeredWorktrees()).length, crashed.worktreeCount);
  } finally { restarted?.close(); rmSync(root, { recursive: true, force: true }); }
});

test("integration_barrier_worktree_created Router restart leaves no checkpoint and no second barrier worktree", async () => {
  const root = repository(); let router; let restarted;
  try {
    router = new SwarmRouter(routerConfig(root, { integration_barrier_worktree_created: crash("integration_barrier_worktree_created") }));
    const overlay = await router.ensureProjectOverlay(); const base = overlay.overlay.repository.baseSha;
    const artifacts = [];
    for (const id of ["barrier-a", "barrier-b"]) {
      const created = router.enqueue({ role: "backend", title: id, prompt: "manual fixture", allowedPaths: ["value.mjs"] });
      router.store.transition(created.id, "preparing"); router.store.transition(created.id, "running");
      const worktree = join(root, "runtime", `${id}-worktree`); git(root, ["worktree", "add", "-b", `fixture/${id}`, worktree, base]); writeFileSync(join(worktree, "value.mjs"), `export const value = '${id}';\n`);
      const finalized = await new WorktreeFinalizer({ repository: root, generatedDir: router.config.project.generatedDir, processRunner: router.processRunner }).finalize({ task: { ...router.store.getTask(created.id), artifactBaseSha: base }, worktree, branch: `fixture/${id}`, overlay: overlay.overlay, overlayPath: overlay.path });
      router.store.recordWorkerArtifact(created.id, finalized.path, finalized.artifact); router.store.transition(created.id, "done"); artifacts.push(finalized.artifact);
    }
    const run = router.createDeliveryRun({ id: "barrier-run" }); router.activateDeliveryRun(run.id);
    router.store.createIntegrationBarrier({ schemaVersion: 1, kind: "IntegrationBarrier", id: "barrier-crash", deliveryRunId: run.id, blueprintId: "blueprint", wave: 1, baseSha: base, inputArtifacts: artifacts.map((artifact) => ({ artifactId: artifact.taskId, headSha: artifact.headSha })), status: "pending", createdAt: "2026-01-01T00:00:00.000Z" });
    await router.runUntilIdle({ deliveryRunId: run.id }); const record = router.store.listManagedWorktrees().find((item) => item.barrierId === "barrier-crash"); assert.ok(record); const count = (await router.worktrees.registeredWorktrees()).length; router.close(); router = null;
    restarted = new SwarmRouter(routerConfig(root)); await restarted.recoverStaleDeliveries(); await restarted.recoverStaleDeliveries();
    assert.equal(restarted.store.integrationBarrier("barrier-crash").status, "failed"); assert.equal(restarted.store.integrationBarrier("barrier-crash").checkpointId, null); assert.equal(restarted.store.managedWorktree(record.recordId).phase, "preserved");
    assert.equal((await restarted.worktrees.registeredWorktrees()).length, count);
  } finally { router?.close(); restarted?.close(); rmSync(root, { recursive: true, force: true }); }
});

test("candidate_integration_worktree_created Router restart preserves ownership without manifest, publication, or retry creation", async () => {
  const root = repository(); let router; let restarted;
  try {
    const candidateConfig = routerConfig(root, { candidate_integration_worktree_created: crash("candidate_integration_worktree_created") }); candidateConfig.roles = { ...candidateConfig.roles, backend: { ...candidateConfig.roles.backend, sandbox: "read-only", usesWorktree: false } };
    router = new SwarmRouter(candidateConfig);
    const overlay = await router.ensureProjectOverlay(); const base = overlay.overlay.repository.baseSha;
    const created = router.enqueue({ role: "backend", title: "candidate writer", prompt: "manual fixture", allowedPaths: ["value.mjs"] });
    router.store.transition(created.id, "preparing"); router.store.transition(created.id, "running");
    const worktree = join(root, "candidate-writer"); git(root, ["worktree", "add", "-b", "fixture/candidate-writer", worktree, base]); writeFileSync(join(worktree, "value.mjs"), "export const value = 3;\n");
    const finalized = await new WorktreeFinalizer({ repository: root, generatedDir: router.config.project.generatedDir, processRunner: router.processRunner }).finalize({ task: { ...router.store.getTask(created.id), artifactBaseSha: base }, worktree, branch: "fixture/candidate-writer", overlay: overlay.overlay, overlayPath: overlay.path });
    router.store.recordWorkerArtifact(created.id, finalized.path, finalized.artifact); router.store.transition(created.id, "done");
    const run = router.createDeliveryRun({ id: "candidate-run" }); router.activateDeliveryRun(run.id);
    await assert.rejects(router.integrateFinalized([created.id]), /candidate_integration_worktree_created/);
    const record = router.store.listManagedWorktrees().find((item) => item.kind === "candidate_integration"); const count = (await router.worktrees.registeredWorktrees()).length; router.close(); router = null;
    const restartConfig = routerConfig(root); restartConfig.roles = candidateConfig.roles; restarted = new SwarmRouter(restartConfig); restarted.activateDeliveryRun("candidate-run"); await restarted.recoverStaleDeliveries(); await restarted.recoverStaleDeliveries();
    assert.equal(restarted.store.managedWorktree(record.recordId).phase, "linked"); assert.equal(existsSync(join(root, "docs", "orchestration-generated", "integration-manifests")), false);
    await assert.rejects(restarted.integrateFinalized([created.id]), /already has durable ownership record/); assert.equal((await restarted.worktrees.registeredWorktrees()).length, count);
  } finally { router?.close(); restarted?.close(); rmSync(root, { recursive: true, force: true }); }
});

test("read-only status/watch view and integrity-blocked admission do not mutate a partial crash runtime", async () => {
  const root = repository(); let restarted; let reader;
  try {
    const crashed = await crashedRouter(root, "artifact_file_before_db_persistence");
    const dbPath = join(root, "runtime", "swarm.sqlite"); const lifecyclePath = join(root, "runtime", "lifecycle.jsonl"); const beforeDb = statSync(dbPath).mtimeMs; const beforeLifecycle = statSync(lifecyclePath).mtimeMs;
    reader = new SwarmRouter(routerConfig(root), { readOnly: true }); const status = reader.statusSnapshot(); const watch = reader.statusSnapshot();
    assert.equal(status.managedWorktrees.some((record) => record.recordId === crashed.recordId), true); assert.equal(watch.managedWorktreeInventory.readOnly, true);
    assert.equal(statSync(dbPath).mtimeMs, beforeDb); assert.equal(statSync(lifecyclePath).mtimeMs, beforeLifecycle); reader.close(); reader = null;
    restarted = new SwarmRouter(routerConfig(root)); const record = restarted.store.managedWorktree(crashed.recordId); restarted.store.db.prepare("UPDATE managed_worktrees SET intended_path = ? WHERE record_id = ?").run(join(root, "README.md"), record.recordId);
    let leases = 0, claims = 0; const lease = restarted.store.claimDeliveryLease.bind(restarted.store); const claim = restarted.store.claimNext.bind(restarted.store); restarted.store.claimDeliveryLease = (...args) => { leases += 1; return lease(...args); }; restarted.store.claimNext = (...args) => { claims += 1; return claim(...args); };
    const result = await restarted.runUntilIdle(); assert.equal(result.integrityBlocked, true); assert.match(result.reconciliation.error, /Managed worktree reconciliation requires recovery/); assert.ok(result.reconciliation.error.length <= 300); assert.equal(leases, 0); assert.equal(claims, 0);
  } finally { reader?.close(); restarted?.close(); rmSync(root, { recursive: true, force: true }); }
});
