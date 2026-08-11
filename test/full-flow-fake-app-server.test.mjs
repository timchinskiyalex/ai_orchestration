import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { SwarmRouter } from "../src/router.mjs";

const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
class FakeAppServer extends EventEmitter {
  constructor() { super(); this.next = 1; this.threads = new Map(); }
  async connect() {}
  shutdown() {}
  diagnostics() { return { protocolEvents: [], stderrTail: "", process: { alive: false, exited: false, code: null, signal: null } }; }
  async request(method) { if (method === "account/read") return { account: {} }; if (method === "account/usage/read") return { dailyUsageBuckets: [] }; if (method === "account/rateLimits/read") return { rateLimits: null }; return {}; }
  async startThread({ cwd }) { const id = `thread-${this.next++}`; this.threads.set(id, { cwd, goal: "", turnId: null }); return { thread: { id } }; }
  async setGoal({ threadId, objective }) { this.threads.get(threadId).goal = objective; }
  async startTurn({ threadId }) { const thread = this.threads.get(threadId); thread.turnId = `turn-${threadId}`; return { turn: { id: thread.turnId } }; }
  async waitForTurn(threadId, turnId) { const thread = this.threads.get(threadId); if (/Fix value/.test(thread.goal)) writeFileSync(join(thread.cwd, "src", "value.mjs"), "export const value = 2;\n"); return { id: turnId, status: "completed" }; }
  async readThread({ threadId }) { const thread = this.threads.get(threadId); const text = /^Plan /.test(thread.goal) ? "```json\n{\"tasks\":[{\"id\":\"fix-value\",\"title\":\"Fix value\",\"prompt\":\"Fix value\",\"primaryDomain\":\"backend\",\"supportingDomains\":[\"security\"],\"riskFlags\":[\"auth_or_authorization\"],\"humanApprovalRequired\":false,\"estimatedTokens\":20,\"dependsOn\":[],\"allowedPaths\":[\"src/value.mjs\"],\"acceptanceChecks\":[\"npm test\"]}]}\n```" : /^Bootstrap /.test(thread.goal) ? "```json\n{\"summary\":\"ok\",\"assumptions\":[],\"risks\":[],\"humanGates\":[]}\n```" : /^Security review:/.test(thread.goal) ? "```json\n{\"verdict\":\"pass\",\"summary\":\"secure\",\"findings\":[],\"executedChecks\":[],\"notRunChecks\":[]}\n```" : /^QA:/.test(thread.goal) ? "```json\n{\"verdict\":\"pass\",\"summary\":\"verified\",\"findings\":[],\"executedChecks\":[],\"notRunChecks\":[]}\n```" : "verification complete"; return { thread: { turns: [{ id: thread.turnId, items: [{ type: "agentMessage", text }] } ] } }; }
}
test("quota-free autonomous flow materializes DAG, Security/QA, finalizes writer, and integrates", async () => {
  const root = mkdtempSync(join(tmpdir(), "orchestration-full-flow-")); let router;
  try {
    git(root, ["init", "-b", "main"]); mkdirSync(join(root, "src")); mkdirSync(join(root, "test")); mkdirSync(join(root, "docs", "orchestration-input"), { recursive: true });
    writeFileSync(join(root, "docs", "orchestration-input", "inventory.json"), "{}", "utf8"); writeFileSync(join(root, "package.json"), JSON.stringify({ packageManager: "npm@10", scripts: { test: "node --test" } })); writeFileSync(join(root, "package-lock.json"), "{}"); writeFileSync(join(root, "src", "value.mjs"), "export const value = 1;\n"); writeFileSync(join(root, "test", "value.test.mjs"), "import test from 'node:test'; import assert from 'node:assert/strict'; import { value } from '../src/value.mjs'; test('v',()=>assert.equal(value,2));\n");
    git(root, ["add", "."]); git(root, ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "base"]);
    const roles = Object.fromEntries(["bootstrap", "planner", "backend", "frontend", "database", "qa", "security", "devops"].map((role) => [role, { sandbox: role === "backend" ? "workspace-write" : "read-only", approvalPolicy: "never", tokenBudget: 100, usesWorktree: role === "backend" }]));
    router = new SwarmRouter({ repository: root, runtimeDir: join(root, "runtime"), baseRef: "main", model: "fake", project: { name: "fake", documentationDir: "docs/orchestration-input", generatedDir: "docs/orchestration-generated" }, router: { maxConcurrentTasks: 1, maxChildrenPerTask: 5, maxDelegationDepth: 4, maxPlanTasks: 5, defaultParentBudget: 1000, turnTimeoutMs: 1000, approvalMode: "deny" }, autonomy: { mode: "autonomous", autoApproveWorkflowGates: true, autoRemediate: true, autoPush: true, autoCreatePullRequest: true, autoMerge: true, maxRemediationRounds: 3 }, budget: { weeklyTokenLimit: 10000, weeklyWindowDays: 7 }, quota: { throttleAtUsedPercent: 90, throttleWhenUnavailable: false }, roles, appServerClientFactory: () => new FakeAppServer() });
    await router.ensureProjectOverlay(); router.startProject(); await router.runUntilIdle();
    const tasks = router.list(); const backend = tasks.find((task) => task.role === "backend"); const security = tasks.find((task) => task.role === "security"); const qa = tasks.find((task) => task.role === "qa");
    assert.ok(backend && security && qa, JSON.stringify(tasks.map((task) => ({ role: task.role, status: task.status, error: task.error })))); assert.equal(backend.status, "done"); assert.deepEqual(security.dependencies, [backend.id]); assert.deepEqual(qa.dependencies, [security.id]);
    assert.equal(router.store.getTask(backend.id).status, "done"); assert.equal(router.store.getTask(security.id).status, "done"); assert.equal(router.store.getTask(qa.id).status, "done"); assert.equal(router.store.securityReport(security.id).report.verdict, "pass"); assert.equal(router.store.qualityReport(qa.id).report.verdict, "pass"); const artifact = router.store.workerArtifactRecord(backend.id); assert.ok(artifact?.path);
    const integration = await router.integrateFinalized([backend.id]); assert.equal(integration.manifest.status, "candidate_ready");
  } finally { router?.close(); rmSync(root, { recursive: true, force: true }); }
});
