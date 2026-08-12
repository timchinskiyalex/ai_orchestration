import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { DeliveryCoordinator } from "../src/delivery-coordinator.mjs";
import { SwarmRouter } from "../src/router.mjs";
import { fakeBlueprint, fakePlan } from "./product-blueprint-fixture.mjs";

const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
class DeliveryClient extends EventEmitter {
  constructor() { super(); this.id = 0; this.threads = new Map(); this.goals = []; }
  async connect() {} shutdown() {} diagnostics() { return { protocolEvents: [], stderrTail: "", process: {} }; }
  async request(method) { return method === "account/read" ? { account: {} } : method === "account/usage/read" ? { dailyUsageBuckets: [] } : { rateLimits: null }; }
  async startThread({ cwd }) { const id = `thread-${++this.id}`; this.threads.set(id, { cwd, goal: "" }); return { thread: { id } }; }
  async setGoal(goal) { this.goals.push(goal); this.threads.get(goal.threadId).goal = goal.objective; }
  async startTurn({ threadId }) { return { turn: { id: `turn-${threadId}` } }; }
  async waitForTurn(threadId, turnId) { const thread = this.threads.get(threadId); if (/Writer/.test(thread.goal)) writeFileSync(join(thread.cwd, "src", "value.mjs"), "export const value = 2;\n"); return { id: turnId, status: "completed" }; }
  async readThread({ threadId }) { const thread = this.threads.get(threadId); const text = /^Bootstrap/.test(thread.goal) ? `\`\`\`json\n${JSON.stringify(fakeBlueprint(thread.cwd))}\n\`\`\`` : /^Plan /.test(thread.goal) ? `\`\`\`json\n${JSON.stringify(fakePlan())}\n\`\`\`` : /^Security review:/.test(thread.goal) ? "```json\n{\"verdict\":\"pass\",\"summary\":\"secure\",\"findings\":[],\"executedChecks\":[],\"notRunChecks\":[]}\n```" : /^QA:/.test(thread.goal) ? "```json\n{\"verdict\":\"pass\",\"summary\":\"quality verified\",\"findings\":[],\"executedChecks\":[],\"notRunChecks\":[]}\n```" : "writer complete"; return { thread: { turns: [{ id: `turn-${threadId}`, items: [{ type: "agentMessage", text }] }] } }; }
}
class CorrectingPlannerClient extends DeliveryClient {
  constructor() { super(); this.plannerReads = 0; }
  async readThread({ threadId }) {
    const thread = this.threads.get(threadId);
    if (/^Plan /.test(thread.goal)) {
      this.plannerReads += 1;
      const text = this.plannerReads === 1
        ? "```json\n{\"tasks\":[{\"id\":\"writer\",\"title\":\"Writer\",\"prompt\":\"Writer\",\"primaryDomain\":\"backend\",\"supportingDomains\":[],\"riskFlags\":[\"invented_flag\"],\"humanApprovalRequired\":false,\"estimatedTokens\":20,\"dependsOn\":[],\"allowedPaths\":[\"src/value.mjs\"],\"acceptanceChecks\":[\"npm test\"]}]}\n```"
        : `\`\`\`json\n${JSON.stringify(fakePlan())}\n\`\`\``;
      return { thread: { turns: [{ id: `turn-${threadId}`, items: [{ type: "agentMessage", text }] }] } };
    }
    return super.readThread({ threadId });
  }
}
class RepairingWriterClient extends DeliveryClient {
  constructor() { super(); this.writerTurns = 0; }
  async waitForTurn(threadId, turnId) {
    const thread = this.threads.get(threadId);
    if (/^Writer/.test(thread.goal)) {
      this.writerTurns += 1;
      writeFileSync(join(thread.cwd, "src", "value.mjs"), `export const value = ${this.writerTurns === 1 ? 1 : 2};\n`);
    }
    return { id: turnId, status: "completed" };
  }
}
function setup(remote = true) {
  const root = mkdtempSync(join(tmpdir(), "delivery-coordinator-")); git(root, ["init", "-b", "main"]); mkdirSync(join(root, "src")); mkdirSync(join(root, "test")); const source = join(root, "requirements"); mkdirSync(source); writeFileSync(join(source, "requirements.md"), "# Requirement\nFix value.\n"); writeFileSync(join(root, "package.json"), JSON.stringify({ packageManager: "npm@10", scripts: { test: "node --test" } })); writeFileSync(join(root, "package-lock.json"), "{}"); writeFileSync(join(root, "src", "value.mjs"), "export const value = 1;\n"); writeFileSync(join(root, "test", "value.test.mjs"), "import test from 'node:test'; import assert from 'node:assert/strict'; import { value } from '../src/value.mjs'; test('value',()=>assert.equal(value,2));\n"); git(root, ["add", "."]); git(root, ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "base"]);
  const roles = Object.fromEntries(["bootstrap", "planner", "backend", "frontend", "database", "qa", "security", "devops"].map((role) => [role, { sandbox: role === "backend" ? "workspace-write" : "read-only", approvalPolicy: "never", tokenBudget: 200, usesWorktree: role === "backend" }]));
  const config = { repository: root, runtimeDir: join(root, "runtime"), baseRef: "main", model: "fake", project: { name: "test", documentationDir: "docs/orchestration-input", generatedDir: "docs/orchestration-generated" }, router: { maxConcurrentTasks: 10, maxChildrenPerTask: 20, maxDelegationDepth: 5, maxPlanTasks: 12, defaultParentBudget: 10000, turnTimeoutMs: 1000, approvalMode: "deny" }, autonomy: { mode: "autonomous", autoApproveWorkflowGates: true, autoRemediate: true, autoPush: true, autoCreatePullRequest: true, autoMerge: true, maxRemediationRounds: 3 }, budget: { weeklyTokenLimit: 10000, weeklyWindowDays: 7 }, quota: { throttleAtUsedPercent: 90, throttleWhenUnavailable: false }, delivery: { maxRemediationRounds: 3 }, remote: { enabled: remote, remoteName: "origin", allowedRemotes: ["origin"], candidateBranchPrefix: "swarm/candidate/", requireCi: true, mergeMethod: "merge" }, roles, appServerClientFactory: () => new DeliveryClient() };
  return { root, source, config };
}

function fakeRemote(calls) {
  return {
    remoteGitAdapter: { async pushCandidate({ sha }) { calls.push += 1; return { status: "pushed", verifiedSha: sha }; } },
    pullRequestAdapter: { async ensurePullRequest({ sha }) { calls.pr += 1; return { status: "open", number: 1, url: "https://example.test/pr/1", headSha: sha }; } },
    remoteCiAdapter: { async waitForChecks() { calls.ci += 1; return { status: "passed", checkRuns: [{ name: "test", status: "completed", conclusion: "success" }] }; } },
    productEvidenceAdapter: { async verify({ candidate }) { return { status: "pass", candidateSha: candidate.sha, reference: "deterministic-product-check" }; } },
    mergeAdapter: { async merge() { calls.merge += 1; return { status: "merged", mainSha: "b".repeat(40), mergeSha: "b".repeat(40), targetVerified: true }; } }
  };
}

test("autonomous Bootstrap, Planner, DAG, gates, candidate publication, and merge complete without a human gate", async () => {
  const fixture = setup(); const router = new SwarmRouter(fixture.config); const coordinator = new DeliveryCoordinator(router); const calls = { push: 0, pr: 0, ci: 0, merge: 0 };
  try {
    const final = await coordinator.begin({ source: fixture.source, ...fakeRemote(calls) });
    assert.equal(final.state, "completed_merged"); assert.ok(final.integrationPath); assert.equal(router.statusSnapshot().securityReports[0].verdict, "pass"); assert.equal(router.statusSnapshot().qualityReports[0].verdict, "pass"); assert.deepEqual(calls, { push: 1, pr: 1, ci: 1, merge: 1 });
  } finally { router.close(); rmSync(fixture.root, { recursive: true, force: true }); }
});
test("completed autonomous delivery is restart-idempotent", async () => {
  const fixture = setup(true); const router = new SwarmRouter(fixture.config); const coordinator = new DeliveryCoordinator(router); const calls = { push: 0, pr: 0, ci: 0, merge: 0 };
  try {
    const ready = await coordinator.begin({ source: fixture.source, ...fakeRemote(calls) }); assert.equal(ready.state, "completed_merged");
    const restarted = await coordinator.resume(fakeRemote(calls)); assert.equal(restarted.state, "completed_merged"); assert.deepEqual(calls, { push: 1, pr: 1, ci: 1, merge: 1 });
  } finally { router.close(); rmSync(fixture.root, { recursive: true, force: true }); }
});

test("persisted candidate resumes CI blockers and interruptions without a new intake, Bootstrap, or DAG", async () => {
  const fixture = setup(true); const client = new DeliveryClient(); fixture.config.appServerClientFactory = () => client;
  const router = new SwarmRouter(fixture.config); const coordinator = new DeliveryCoordinator(router); const calls = { push: 0, pr: 0, ci: 0, merge: 0 };
  try {
    const blockedAdapters = { ...fakeRemote(calls), remoteCiAdapter: { async waitForChecks() { calls.ci += 1; return { status: "timed_out", reason: "required build pending" }; } } };
    const blocked = await coordinator.begin({ source: fixture.source, ...blockedAdapters });
    assert.equal(blocked.state, "blocked_ci"); assert.ok(blocked.integrationPath); assert.equal(blocked.candidate.sha.length, 40);
    assert.equal(router.store.deliveryRun(blocked.id).publicationCheckpoint.stage, "ci");
    const beforeResumeGoals = client.goals.length;
    const resumed = await coordinator.resume(fakeRemote(calls));
    assert.equal(resumed.state, "completed_merged"); assert.equal(client.goals.length, beforeResumeGoals); assert.equal(router.list().filter((task) => task.role === "bootstrap").length, 1);
    router.store.interruptDeliveryRun(resumed.id, { reason: "test restart after merge side effect" });
    const afterInterrupt = await coordinator.resume(fakeRemote(calls));
    assert.equal(afterInterrupt.state, "completed_merged"); assert.equal(router.list().filter((task) => task.role === "bootstrap").length, 1); assert.equal(calls.merge, 1);
  } finally { router.close(); rmSync(fixture.root, { recursive: true, force: true }); }
});

test("a fresh delivery cancels stranded historical tasks but preserves their records", async () => {
  const fixture = setup(true); const router = new SwarmRouter(fixture.config); const coordinator = new DeliveryCoordinator(router); const calls = { push: 0, pr: 0, ci: 0, merge: 0 };
  try {
    const stranded = router.enqueue({ role: "backend", title: "old stranded task", prompt: "old", estimatedTokens: 20 });
    const final = await coordinator.begin({ source: fixture.source, ...fakeRemote(calls) });
    assert.equal(router.store.getTask(stranded.id).status, "cancelled");
    assert.match(router.store.getTask(stranded.id).error, /superseded_by_fresh_delivery/);
    assert.equal(final.state, "completed_merged");
  } finally { router.close(); rmSync(fixture.root, { recursive: true, force: true }); }
});

test("tracking-only delivery keeps worker goals uncapped while bounding planning goals", async () => {
  const fixture = setup(false); fixture.config.budget.enforceLocalLimits = false;
  const client = new DeliveryClient(); fixture.config.appServerClientFactory = () => client;
  const router = new SwarmRouter(fixture.config); const coordinator = new DeliveryCoordinator(router);
  try {
    await coordinator.begin({ source: fixture.source });
    assert.ok(client.goals.length > 2);
    assert.equal(client.goals.filter((goal) => /^(Bootstrap|Plan )/.test(goal.objective)).every((goal) => "tokenBudget" in goal), true);
    assert.equal(client.goals.filter((goal) => !/^(Bootstrap|Plan )/.test(goal.objective)).some((goal) => "tokenBudget" in goal), false);
  } finally { router.close(); rmSync(fixture.root, { recursive: true, force: true }); }
});

test("planner validation is repaired in the same delivery run without a new Bootstrap", async () => {
  const fixture = setup(false); const client = new CorrectingPlannerClient(); fixture.config.appServerClientFactory = () => client;
  const router = new SwarmRouter(fixture.config); const coordinator = new DeliveryCoordinator(router);
  try {
    await coordinator.begin({ source: fixture.source });
    assert.equal(client.plannerReads, 2);
    assert.equal(router.list().filter((task) => task.role === "bootstrap").length, 1);
    assert.equal(router.list().find((task) => task.role === "planner").status, "done");
  } finally { router.close(); rmSync(fixture.root, { recursive: true, force: true }); }
});

test("writer verification failure is repaired in the same worker thread before finalization", async () => {
  const fixture = setup(false); const client = new RepairingWriterClient(); fixture.config.appServerClientFactory = () => client;
  const router = new SwarmRouter(fixture.config); const coordinator = new DeliveryCoordinator(router);
  try {
    await coordinator.begin({ source: fixture.source });
    const writer = router.list().find((task) => task.title === "Writer");
    assert.equal(writer.status, "done");
    assert.equal(client.writerTurns, 2);
    assert.ok(router.store.workerArtifact(writer.id));
    assert.equal(router.lifecycleEvents().some((event) => event.type === "writer verification retry"), true);
  } finally { router.close(); rmSync(fixture.root, { recursive: true, force: true }); }
});

test("delivery coordinator refuses completion while any task remains running", async () => {
  const run = { id: "run-active", state: "running" };
  let integrationAttempted = false;
  const router = {
    recoverStaleDeliveries() { return []; }, activateDeliveryRun() {}, isAutonomous() { return true; },
    list() { return [{ id: "still-running", role: "bootstrap", status: "running", deliveryRunId: run.id }]; },
    async runUntilIdle() { return { blockedQuota: false, blockedBudget: false, interrupted: false, failed: false }; },
    async runToIntegration() { integrationAttempted = true; throw new Error("must not integrate"); },
    store: {
      currentDeliveryRun() { return run; }, deliveryRun() { return run; },
      updateDeliveryRun(id, update) { return { ...run, id, ...update }; }
    }
  };
  const terminal = await new DeliveryCoordinator(router).resume();
  assert.equal(terminal.state, "failed");
  assert.match(terminal.publish.reason, /still-running remains running/);
  assert.equal(integrationAttempted, false);

});
