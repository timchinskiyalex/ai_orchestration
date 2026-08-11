import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { SwarmRouter } from "../src/router.mjs";

const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
class DeliveryFake extends EventEmitter {
  constructor() { super(); this.sequence = 1; this.threads = new Map(); this.qaRuns = 0; }
  async connect() {} shutdown() {} diagnostics() { return { protocolEvents: [], stderrTail: "", process: {} }; }
  async request(method) { return method === "account/read" ? { account: {} } : method === "account/usage/read" ? { dailyUsageBuckets: [] } : { rateLimits: null }; }
  async startThread({ cwd }) { const id = `t-${this.sequence++}`; this.threads.set(id, { cwd, goal: "" }); return { thread: { id } }; }
  async setGoal({ threadId, objective }) { this.threads.get(threadId).goal = objective; }
  async startTurn({ threadId }) { return { turn: { id: `turn-${threadId}` } }; }
  async waitForTurn(threadId, turnId) { const thread = this.threads.get(threadId); if (/Writer/.test(thread.goal)) writeFileSync(join(thread.cwd, "src", "value.mjs"), "export const value = 2;\n"); if (/Remediate/.test(thread.goal)) writeFileSync(join(thread.cwd, "src", "value.mjs"), "export const value = 2; // remediated\n"); return { id: turnId, status: "completed" }; }
  async readThread({ threadId }) { const thread = this.threads.get(threadId); const text = /^QA:/.test(thread.goal) ? (++this.qaRuns === 1 ? "```json\n{\"verdict\":\"remediation_required\",\"summary\":\"Fix is bounded.\",\"findings\":[{\"id\":\"QA-1\",\"severity\":\"medium\",\"path\":\"src/value.mjs\",\"evidence\":\"A controller-visible file needs a small correction.\",\"requiredFix\":\"Add the required remediation marker only.\",\"verification\":\"npm test\"}],\"executedChecks\":[],\"notRunChecks\":[]}\n```" : "```json\n{\"verdict\":\"pass\",\"summary\":\"Remediation verified.\",\"findings\":[],\"executedChecks\":[],\"notRunChecks\":[]}\n```") : "review complete"; return { thread: { turns: [{ id: `turn-${threadId}`, items: [{ type: "agentMessage", text }] }] } }; }
}

test("QA remediation creates a chained writer, rechecks it, and integrates once", async () => {
  const root = mkdtempSync(join(tmpdir(), "delivery-remediation-")); let router;
  try {
    git(root, ["init", "-b", "main"]); mkdirSync(join(root, "src")); mkdirSync(join(root, "test"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ packageManager: "npm@10", scripts: { test: "node --test" } })); writeFileSync(join(root, "package-lock.json"), "{}"); writeFileSync(join(root, "src", "value.mjs"), "export const value = 1;\n"); writeFileSync(join(root, "test", "value.test.mjs"), "import test from 'node:test'; import assert from 'node:assert/strict'; import { value } from '../src/value.mjs'; test('value',()=>assert.equal(value,2));\n");
    git(root, ["add", "."]); git(root, ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "base"]);
    const roles = Object.fromEntries(["bootstrap", "planner", "backend", "frontend", "database", "qa", "security", "devops"].map((role) => [role, { sandbox: role === "backend" ? "workspace-write" : "read-only", approvalPolicy: "never", tokenBudget: 200, usesWorktree: role === "backend" }]));
    router = new SwarmRouter({ repository: root, runtimeDir: join(root, "runtime"), baseRef: "main", model: "fake", project: { name: "test", documentationDir: "docs/in", generatedDir: "docs/orchestration-generated" }, router: { maxConcurrentTasks: 10, maxChildrenPerTask: 20, maxDelegationDepth: 5, maxPlanTasks: 12, defaultParentBudget: 10000, turnTimeoutMs: 1000, approvalMode: "deny" }, budget: { weeklyTokenLimit: 10000, weeklyWindowDays: 7 }, quota: { throttleAtUsedPercent: 90, throttleWhenUnavailable: false }, delivery: { maxRemediationRounds: 2 }, roles, appServerClientFactory: () => new DeliveryFake() });
    await router.ensureProjectOverlay(); const writer = router.enqueue({ role: "backend", title: "Writer", prompt: "Writer", allowedPaths: ["src"], acceptanceChecks: ["npm test"], estimatedTokens: 100 }); const security = router.enqueue({ role: "security", title: "Security review", prompt: "Review", parentTaskId: writer.id, dependencies: [writer.id], allowedPaths: ["src"], estimatedTokens: 100, sourceWriterTaskId: writer.id }); router.enqueue({ role: "qa", title: "QA: Writer", prompt: "QA", parentTaskId: security.id, dependencies: [security.id], allowedPaths: ["src"], acceptanceChecks: ["npm test"], estimatedTokens: 100, sourceWriterTaskId: writer.id });
    await router.runUntilIdle();
    const remediation = router.list().find((task) => /^Remediate /.test(task.title)); const remediationQa = router.list().find((task) => task.role === "qa" && task.sourceWriterTaskId === remediation?.id);
    assert.ok(remediation); assert.equal(remediation.status, "done"); assert.equal(remediation.artifactBaseSha, router.store.workerArtifact(writer.id).headSha); assert.equal(remediationQa.status, "done"); assert.equal(router.store.qualityReport(remediationQa.id).report.verdict, "pass");
    const integrated = await router.integrateFinalized([writer.id, remediation.id]); assert.equal(integrated.manifest.status, "awaiting_human_merge"); assert.deepEqual(integrated.manifest.appliedArtifacts, [writer.id, remediation.id]);
  } finally { router?.close(); rmSync(root, { recursive: true, force: true }); }
});
