import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { DeliveryCoordinator } from "../src/delivery-coordinator.mjs";
import { SwarmRouter } from "../src/router.mjs";

const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
class DeliveryClient extends EventEmitter {
  constructor() { super(); this.id = 0; this.threads = new Map(); this.goals = []; }
  async connect() {} shutdown() {} diagnostics() { return { protocolEvents: [], stderrTail: "", process: {} }; }
  async request(method) { return method === "account/read" ? { account: {} } : method === "account/usage/read" ? { dailyUsageBuckets: [] } : { rateLimits: null }; }
  async startThread({ cwd }) { const id = `thread-${++this.id}`; this.threads.set(id, { cwd, goal: "" }); return { thread: { id } }; }
  async setGoal(goal) { this.goals.push(goal); this.threads.get(goal.threadId).goal = goal.objective; }
  async startTurn({ threadId }) { return { turn: { id: `turn-${threadId}` } }; }
  async waitForTurn(threadId, turnId) { const thread = this.threads.get(threadId); if (/Writer/.test(thread.goal)) writeFileSync(join(thread.cwd, "src", "value.mjs"), "export const value = 2;\n"); return { id: turnId, status: "completed" }; }
  async readThread({ threadId }) { const thread = this.threads.get(threadId); const text = /^Bootstrap/.test(thread.goal) ? "```json\n{\"summary\":\"ok\",\"assumptions\":[],\"risks\":[],\"humanGates\":[]}\n```" : /^Plan /.test(thread.goal) ? "```json\n{\"tasks\":[{\"id\":\"writer\",\"title\":\"Writer\",\"prompt\":\"Writer\",\"primaryDomain\":\"backend\",\"supportingDomains\":[],\"riskFlags\":[],\"humanApprovalRequired\":false,\"estimatedTokens\":20,\"dependsOn\":[],\"allowedPaths\":[\"src/value.mjs\"],\"acceptanceChecks\":[\"npm test\"]}]}\n```" : /^Security review:/.test(thread.goal) ? "```json\n{\"verdict\":\"pass\",\"summary\":\"secure\",\"findings\":[],\"executedChecks\":[],\"notRunChecks\":[]}\n```" : /^QA:/.test(thread.goal) ? "```json\n{\"verdict\":\"pass\",\"summary\":\"quality verified\",\"findings\":[],\"executedChecks\":[],\"notRunChecks\":[]}\n```" : "writer complete"; return { thread: { turns: [{ id: `turn-${threadId}`, items: [{ type: "agentMessage", text }] }] } }; }
}
function setup(remote = true) {
  const root = mkdtempSync(join(tmpdir(), "delivery-coordinator-")); git(root, ["init", "-b", "main"]); mkdirSync(join(root, "src")); mkdirSync(join(root, "test")); const source = join(root, "requirements"); mkdirSync(source); writeFileSync(join(source, "requirements.md"), "# Requirement\nFix value.\n"); writeFileSync(join(root, "package.json"), JSON.stringify({ packageManager: "npm@10", scripts: { test: "node --test" } })); writeFileSync(join(root, "package-lock.json"), "{}"); writeFileSync(join(root, "src", "value.mjs"), "export const value = 1;\n"); writeFileSync(join(root, "test", "value.test.mjs"), "import test from 'node:test'; import assert from 'node:assert/strict'; import { value } from '../src/value.mjs'; test('value',()=>assert.equal(value,2));\n"); git(root, ["add", "."]); git(root, ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "base"]);
  const roles = Object.fromEntries(["bootstrap", "planner", "backend", "frontend", "database", "qa", "security", "devops"].map((role) => [role, { sandbox: role === "backend" ? "workspace-write" : "read-only", approvalPolicy: "never", tokenBudget: 200, usesWorktree: role === "backend" }]));
  const config = { repository: root, runtimeDir: join(root, "runtime"), baseRef: "main", model: "fake", project: { name: "test", documentationDir: "docs/orchestration-input", generatedDir: "docs/orchestration-generated" }, router: { maxConcurrentTasks: 10, maxChildrenPerTask: 20, maxDelegationDepth: 5, maxPlanTasks: 12, defaultParentBudget: 10000, turnTimeoutMs: 1000, approvalMode: "deny" }, autonomy: { mode: "autonomous", autoApproveWorkflowGates: true, autoRemediate: true, autoPush: true, autoCreatePullRequest: true, autoMerge: true, maxRemediationRounds: 3 }, budget: { weeklyTokenLimit: 10000, weeklyWindowDays: 7 }, quota: { throttleAtUsedPercent: 90, throttleWhenUnavailable: false }, delivery: { maxRemediationRounds: 3 }, remote: { enabled: remote, remoteName: "origin", allowedRemotes: ["origin"], candidateBranchPrefix: "swarm/candidate/", requireCi: true, mergeMethod: "merge" }, roles, appServerClientFactory: () => new DeliveryClient() };
  return { root, source, config };
}

function fakeRemote(calls) {
  return {
    remoteGitAdapter: { async pushCandidate() { calls.push += 1; return { status: "pushed" }; } },
    pullRequestAdapter: { async ensurePullRequest() { calls.pr += 1; return { status: "open", number: 1, url: "https://example.test/pr/1" }; } },
    remoteCiAdapter: { async waitForChecks() { calls.ci += 1; return { status: "passed", checkRuns: [{ name: "test", status: "completed", conclusion: "success" }] }; } },
    mergeAdapter: { async merge() { calls.merge += 1; return { status: "merged", mainSha: "b".repeat(40), mergeSha: "b".repeat(40) }; } }
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
