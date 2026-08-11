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
  constructor() { super(); this.id = 0; this.threads = new Map(); }
  async connect() {} shutdown() {} diagnostics() { return { protocolEvents: [], stderrTail: "", process: {} }; }
  async request(method) { return method === "account/read" ? { account: {} } : method === "account/usage/read" ? { dailyUsageBuckets: [] } : { rateLimits: null }; }
  async startThread({ cwd }) { const id = `thread-${++this.id}`; this.threads.set(id, { cwd, goal: "" }); return { thread: { id } }; }
  async setGoal({ threadId, objective }) { this.threads.get(threadId).goal = objective; }
  async startTurn({ threadId }) { return { turn: { id: `turn-${threadId}` } }; }
  async waitForTurn(threadId, turnId) { const thread = this.threads.get(threadId); if (/Writer/.test(thread.goal)) writeFileSync(join(thread.cwd, "src", "value.mjs"), "export const value = 2;\n"); return { id: turnId, status: "completed" }; }
  async readThread({ threadId }) { const thread = this.threads.get(threadId); const text = /^Bootstrap/.test(thread.goal) ? "```json\n{\"summary\":\"ok\",\"assumptions\":[],\"risks\":[],\"humanGates\":[]}\n```" : /^Plan /.test(thread.goal) ? "```json\n{\"tasks\":[{\"id\":\"writer\",\"title\":\"Writer\",\"prompt\":\"Writer\",\"primaryDomain\":\"backend\",\"supportingDomains\":[],\"riskFlags\":[],\"humanApprovalRequired\":false,\"estimatedTokens\":20,\"dependsOn\":[],\"allowedPaths\":[\"src/value.mjs\"],\"acceptanceChecks\":[\"npm test\"]}]}\n```" : /^Security review:/.test(thread.goal) ? "```json\n{\"verdict\":\"pass\",\"summary\":\"secure\",\"findings\":[],\"executedChecks\":[],\"notRunChecks\":[]}\n```" : /^QA:/.test(thread.goal) ? "```json\n{\"verdict\":\"pass\",\"summary\":\"quality verified\",\"findings\":[],\"executedChecks\":[],\"notRunChecks\":[]}\n```" : "writer complete"; return { thread: { turns: [{ id: `turn-${threadId}`, items: [{ type: "agentMessage", text }] }] } }; }
}
function setup(remote = false) {
  const root = mkdtempSync(join(tmpdir(), "delivery-coordinator-")); git(root, ["init", "-b", "main"]); mkdirSync(join(root, "src")); mkdirSync(join(root, "test")); const source = join(root, "requirements"); mkdirSync(source); writeFileSync(join(source, "requirements.md"), "# Requirement\nFix value.\n"); writeFileSync(join(root, "package.json"), JSON.stringify({ packageManager: "npm@10", scripts: { test: "node --test" } })); writeFileSync(join(root, "package-lock.json"), "{}"); writeFileSync(join(root, "src", "value.mjs"), "export const value = 1;\n"); writeFileSync(join(root, "test", "value.test.mjs"), "import test from 'node:test'; import assert from 'node:assert/strict'; import { value } from '../src/value.mjs'; test('value',()=>assert.equal(value,2));\n"); git(root, ["add", "."]); git(root, ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "base"]);
  const roles = Object.fromEntries(["bootstrap", "planner", "backend", "frontend", "database", "qa", "security", "devops"].map((role) => [role, { sandbox: role === "backend" ? "workspace-write" : "read-only", approvalPolicy: "never", tokenBudget: 200, usesWorktree: role === "backend" }]));
  const config = { repository: root, runtimeDir: join(root, "runtime"), baseRef: "main", model: "fake", project: { name: "test", documentationDir: "docs/orchestration-input", generatedDir: "docs/orchestration-generated" }, router: { maxConcurrentTasks: 10, maxChildrenPerTask: 20, maxDelegationDepth: 5, maxPlanTasks: 12, defaultParentBudget: 10000, turnTimeoutMs: 1000, approvalMode: "deny" }, budget: { weeklyTokenLimit: 10000, weeklyWindowDays: 7 }, quota: { throttleAtUsedPercent: 90, throttleWhenUnavailable: false }, delivery: { maxRemediationRounds: 2 }, remote: { enabled: remote, remoteName: "origin", allowedRemotes: ["origin"], candidateBranchPrefix: "swarm/candidate/", requireCi: false }, roles, appServerClientFactory: () => new DeliveryClient() };
  return { root, source, config };
}

test("delivery begin stops at Bootstrap, approvals plus resume reach verified integration", async () => {
  const fixture = setup(); const router = new SwarmRouter(fixture.config); const coordinator = new DeliveryCoordinator(router);
  try {
    const first = await coordinator.begin({ source: fixture.source }); assert.equal(first.terminalState, "awaiting_human"); assert.match(first.currentGate.approveCommand, /npm run approve/);
    router.approveHumanGate(first.currentGate.taskId); const second = await coordinator.resume(); assert.equal(second.terminalState, "awaiting_human"); const planner = second.currentGate.taskId;
    router.approveHumanGate(planner); const final = await coordinator.resume(); assert.equal(final.state, "awaiting_human"); assert.equal(final.publish.status, "awaiting_human_remote_handoff"); assert.ok(final.integrationPath); assert.equal(router.statusSnapshot().securityReports[0].verdict, "pass"); assert.equal(router.statusSnapshot().qualityReports[0].verdict, "pass");
  } finally { router.close(); rmSync(fixture.root, { recursive: true, force: true }); }
});

test("candidate push is invoked only by confirmed resume after integration and is restart-idempotent", async () => {
  const fixture = setup(true); const router = new SwarmRouter(fixture.config); const coordinator = new DeliveryCoordinator(router); let pushes = 0;
  try {
    const first = await coordinator.begin({ source: fixture.source }); router.approveHumanGate(first.currentGate.taskId); const plan = await coordinator.resume(); router.approveHumanGate(plan.currentGate.taskId);
    const adapter = { async pushCandidate() { pushes += 1; return { status: "pushed" }; } }; const ci = { async verify() { return { status: "passed" }; } };
    const ready = await coordinator.resume({ confirmRemotePush: true, remoteGitAdapter: adapter, remoteCiAdapter: ci }); assert.equal(ready.state, "completed_candidate_ready"); assert.equal(pushes, 1);
    await coordinator.resume({ confirmRemotePush: true, remoteGitAdapter: adapter, remoteCiAdapter: ci }); assert.equal(pushes, 1);
  } finally { router.close(); rmSync(fixture.root, { recursive: true, force: true }); }
});
