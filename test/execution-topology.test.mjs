import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateStore } from "../src/state-store.mjs";
import { compileWriteSurfaceTopology, normalizeAllowedPaths, writeSurfacesOverlap } from "../src/write-surface.mjs";

const sha = (letter) => letter.repeat(40);
const planned = (id, allowedPaths, dependsOn = []) => ({ id, title: id, prompt: id, primaryDomain: "backend", supportingDomains: [], riskFlags: [], humanApprovalRequired: false, estimatedTokens: 1, dependsOn, allowedPaths, acceptanceChecks: [] });
const spec = (id, role, allowedPaths, dependencies = [], extra = {}) => ({ id, role, title: id, prompt: id, allowedPaths, acceptanceChecks: [], dependencies, executionDependencies: [], executionTopologyVersion: 1, executionIsWriter: role === "backend", executionReleaseState: role === "backend" ? "pending" : null, tokenBudget: 10, estimatedTokens: 1, maxAttempts: 1, humanApprovalRequired: false, riskFlags: [], supportingDomains: [], artifactDependencies: [], ...extra });
const batch = (tasks) => ({ schemaVersion: 1, kind: "PlanBatch", id: `batch-${tasks.map((task) => task.id).join("-")}`, deliveryRunId: "run", blueprintId: "blueprint", wave: 1, basedOnCheckpointSha: sha("b"), tasks, createdAt: "2026-01-01T00:00:00.000Z" });
const pass = { schemaVersion: 1, kind: "QualityGateReport", verdict: "pass", summary: "passed", findings: [], executedChecks: [], notRunChecks: [] };
function finish(store, id) { store.transition(id, "running"); return store.transition(id, "done"); }
function recordArtifact(store, id) { store.recordWorkerArtifact(id, `${id}.json`, { schemaVersion: 1, kind: "WorkerArtifact", taskId: id, baseSha: sha("b"), headSha: sha(id === "writer-a" ? "a" : "c"), parentArtifactId: null, dependencies: [] }); }
function createOverlapStore(root) {
  const store = new StateStore(join(root, "swarm.sqlite"));
  const plan = batch([planned("a", ["src/core"]), planned("b", ["src/core/util"])]);
  const writerA = spec("writer-a", "backend", ["src/core"]);
  const writerB = spec("writer-b", "backend", ["src/core/util"], [], { executionDependencies: [writerA.id] });
  const security = spec("security-a", "security", ["src/core"], [writerA.id], { executionIsWriter: false, sourceWriterTaskId: writerA.id });
  const qa = spec("qa-a", "qa", ["src/core"], [security.id], { executionIsWriter: false, sourceWriterTaskId: writerA.id });
  store.createPlanBatch(plan, [writerA, writerB, security, qa]);
  return store;
}

test("write surfaces canonicalize safely and reject ambiguous scopes", () => {
  assert.deepEqual(normalizeAllowedPaths(["src\\core\\", "src/core"]), ["src/core"]);
  assert.equal(writeSurfacesOverlap(["src/core"], ["src/core/util"]), true);
  assert.equal(writeSurfacesOverlap(["src/core"], ["src/core2"]), false);
  assert.equal(writeSurfacesOverlap(["src/api"], ["src/web"]), false);
  for (const scope of ["", ".", "/", "/src", "C:src", "C:\\src", "\\\\server\\share", "src/../secret", "src/*", "src/[core]"]) assert.throws(() => normalizeAllowedPaths([scope]), /Invalid write surface/);
});

test("controller topology is deterministic across adversarial planner order", () => {
  const tasks = [planned("writer-b", ["src/core/util"]), planned("writer-a", ["src/core"]), planned("writer-c", ["src/api"])];
  const reversed = [...tasks].reverse();
  const render = (value) => Object.fromEntries([...compileWriteSurfaceTopology(value, { isWorkspaceWriter: () => true })].map(([id, topology]) => [id, topology.executionDependencies]));
  assert.deepEqual(render(tasks), { "writer-a": [], "writer-b": ["writer-a"], "writer-c": [] });
  assert.deepEqual(render(reversed), render(tasks));
});

test("overlapping successor waits for persisted passed-review release across restart", () => {
  const root = mkdtempSync(join(tmpdir(), "execution-topology-")); let store;
  try {
    store = createOverlapStore(root);
    const writer = store.claimNext(); assert.equal(writer.id, "writer-a");
    finish(store, writer.id); recordArtifact(store, writer.id);
    assert.equal(store.claimNext()?.id, "security-a", "writer-b must not claim when writer-a is merely done");
    store.close(); store = new StateStore(join(root, "swarm.sqlite"));
    assert.equal(store.claimNext(), null, "restart must retain pending safe release");
    const security = store.getTask("security-a"); finish(store, security.id); store.recordSecurityReport({ securityTaskId: security.id, writerTaskId: "writer-a", reportPath: "security.json", report: pass });
    const qa = store.claimNext(); assert.equal(qa.id, "qa-a"); finish(store, qa.id); store.recordQualityReport({ qaTaskId: qa.id, writerTaskId: "writer-a", reportPath: "qa.json", report: pass });
    store.releaseWriterAfterPassedReviews("writer-a", qa.id);
    assert.equal(store.getTask("writer-a").executionReleaseState, "released");
    assert.equal(store.claimNext()?.id, "writer-b");
  } finally { store?.close(); rmSync(root, { recursive: true, force: true }); }
});

test("failed QA/remediation release leaves an overlapping successor blocked", () => {
  const root = mkdtempSync(join(tmpdir(), "execution-topology-failure-")); let store;
  try {
    store = createOverlapStore(root);
    const writer = store.claimNext(); finish(store, writer.id); recordArtifact(store, writer.id);
    const security = store.claimNext(); finish(store, security.id); store.recordSecurityReport({ securityTaskId: security.id, writerTaskId: "writer-a", reportPath: "security.json", report: pass });
    const qa = store.claimNext(); finish(store, qa.id);
    store.recordQualityReport({ qaTaskId: qa.id, writerTaskId: "writer-a", reportPath: "qa.json", report: { ...pass, verdict: "remediation_required" } });
    store.blockWriterRelease("writer-a", "quality gate verdict: remediation_required");
    assert.equal(store.getTask("writer-a").executionReleaseState, "blocked");
    assert.equal(store.claimNext(), null, "successor must not use the original artifact after remediation is required");
  } finally { store?.close(); rmSync(root, { recursive: true, force: true }); }
});

test("direct logical writer dependencies still require the controller release", () => {
  const root = mkdtempSync(join(tmpdir(), "execution-topology-logical-")); let store;
  try {
    store = new StateStore(join(root, "swarm.sqlite"));
    const plan = batch([planned("a", ["src/core"]), planned("b", ["src/core/util"], ["a"])]);
    const writerA = spec("writer-a", "backend", ["src/core"]);
    const writerB = spec("writer-b", "backend", ["src/core/util"], [writerA.id]);
    store.createPlanBatch(plan, [writerA, writerB]);
    const writer = store.claimNext(); finish(store, writer.id); recordArtifact(store, writer.id);
    assert.deepEqual(store.getTask("writer-b").executionDependencies, [], "planner DAG remains separate from controller execution topology");
    assert.equal(store.claimNext(), null, "a logical writer successor cannot bypass review release");
  } finally { store?.close(); rmSync(root, { recursive: true, force: true }); }
});

test("legacy PlanBatch rows without topology are blocked on resume", () => {
  const root = mkdtempSync(join(tmpdir(), "execution-topology-legacy-")); let store;
  try {
    store = new StateStore(join(root, "swarm.sqlite"));
    store.createTask({ id: "legacy", role: "backend", title: "legacy", prompt: "legacy", allowedPaths: ["src/core"], acceptanceChecks: [], dependencies: [], humanApprovalRequired: false, tokenBudget: 1, estimatedTokens: 1, maxAttempts: 1, riskFlags: [], supportingDomains: [], artifactDependencies: [], planBatchId: "legacy-batch", wave: 1 });
    store.close(); store = new StateStore(join(root, "swarm.sqlite"));
    assert.equal(store.getTask("legacy").status, "blocked_specification");
    assert.match(store.getTask("legacy").error, /legacy_execution_topology_incomplete/);
  } finally { store?.close(); rmSync(root, { recursive: true, force: true }); }
});

test("disjoint writers have genuinely overlapping claims with concurrency two", async () => {
  const root = mkdtempSync(join(tmpdir(), "execution-topology-parallel-")); let store;
  try {
    store = new StateStore(join(root, "swarm.sqlite"));
    const plan = batch([planned("a", ["src/api"]), planned("b", ["src/web"])]);
    store.createPlanBatch(plan, [spec("writer-a", "backend", ["src/api"]), spec("writer-b", "backend", ["src/web"])]);
    const maxConcurrentTasks = 2; const starts = [];
    const start = async () => { const task = store.claimNext(); assert.ok(task); store.transition(task.id, "running"); starts.push({ id: task.id, at: Date.now() }); await new Promise((resolve) => setTimeout(resolve, 25)); return task; };
    const [left, right] = await Promise.all(Array.from({ length: maxConcurrentTasks }, start));
    assert.notEqual(left.id, right.id);
    assert.ok(Math.abs(starts[0].at - starts[1].at) < 25, `expected overlapping starts, got ${JSON.stringify(starts)}`);
    assert.equal(store.listTasks().filter((task) => task.status === "running").length, 2);
  } finally { store?.close(); rmSync(root, { recursive: true, force: true }); }
});
