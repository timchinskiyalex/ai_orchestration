import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SwarmRouter } from "../src/router.mjs";
import { fakeBlueprint } from "./product-blueprint-fixture.mjs";
import { documentIdForPath, documentSetDigest } from "../src/product-blueprint.mjs";

const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

class LineageClient extends EventEmitter {
  constructor(plan) { super(); this.plan = plan; this.next = 0; this.threads = new Map(); this.writerBases = new Map(); }
  async connect() {}
  shutdown() {}
  diagnostics() { return { protocolEvents: [], stderrTail: "", process: {} }; }
  async request(method) { return method === "account/read" ? { account: {} } : method === "account/usage/read" ? { dailyUsageBuckets: [] } : { rateLimits: null }; }
  async startThread({ cwd }) { const id = `thread-${++this.next}`; this.threads.set(id, { cwd, goal: "", turn: null }); return { thread: { id } }; }
  async setGoal({ threadId, objective }) { this.threads.get(threadId).goal = objective; }
  async startTurn({ threadId }) { const thread = this.threads.get(threadId); thread.turn = `${threadId}-turn`; return { turn: { id: thread.turn } }; }
  async waitForTurn(threadId, turnId) {
    const thread = this.threads.get(threadId);
    if (/^Write A\n\nWrite A$/.test(thread.goal)) { this.writerBases.set("writer-a", git(thread.cwd, ["rev-parse", "HEAD"])); writeFileSync(join(thread.cwd, "src", "a.mjs"), "export const a = true;\n"); }
    if (/^Write C\n\nWrite C$/.test(thread.goal)) { this.writerBases.set("writer-c", git(thread.cwd, ["rev-parse", "HEAD"])); writeFileSync(join(thread.cwd, "src", "c.mjs"), "export const c = true;\n"); }
    if (/^Write B\n\nWrite B$/.test(thread.goal)) { this.writerBases.set("writer-b", git(thread.cwd, ["rev-parse", "HEAD"])); writeFileSync(join(thread.cwd, "src", "b.mjs"), "export const b = true;\n"); }
    return { id: turnId, status: "completed" };
  }
  async readThread({ threadId }) {
    const goal = this.threads.get(threadId).goal;
    const text = /^Bootstrap/.test(goal)
      ? `\`\`\`json\n${JSON.stringify(fakeBlueprint(this.threads.get(threadId).cwd))}\n\`\`\``
      : /^Plan /.test(goal)
        ? `\`\`\`json\n${JSON.stringify(this.plan)}\n\`\`\``
        : /^Security review:/.test(goal) || /^QA:/.test(goal)
          ? "```json\n{\"verdict\":\"pass\",\"summary\":\"ok\",\"findings\":[],\"executedChecks\":[],\"notRunChecks\":[]}\n```"
          : "writer complete";
    const thread = this.threads.get(threadId); return { thread: { turns: [{ id: thread.turn, items: [{ type: "agentMessage", text }] }] } };
  }
}

const writer = (id, title, dependsOn = []) => ({ id, title, prompt: title, primaryDomain: "backend", supportingDomains: [], riskFlags: [], humanApprovalRequired: false, estimatedTokens: 20, dependsOn, allowedPaths: [`src/${id === "writer-a" ? "a" : id === "writer-c" ? "c" : "b"}.mjs`], acceptanceChecks: [], requirementIds: ["fix-value"] });
function config(root, client) {
  const roles = Object.fromEntries(["bootstrap", "planner", "backend", "frontend", "database", "qa", "security", "devops"].map((role) => [role, { sandbox: role === "backend" ? "workspace-write" : "read-only", approvalPolicy: "never", tokenBudget: 100, usesWorktree: role === "backend" }]));
  return { repository: root, runtimeDir: join(root, "runtime"), baseRef: "main", model: "fake", project: { name: "lineage", documentationDir: "docs/orchestration-input", generatedDir: "docs/orchestration-generated", productRoots: [] }, router: { maxConcurrentTasks: 1, maxChildrenPerTask: 10, maxDelegationDepth: 5, maxPlanTasks: 5, defaultParentBudget: 1000, turnTimeoutMs: 1000, approvalMode: "deny" }, autonomy: { mode: "autonomous", autoApproveWorkflowGates: true, autoRemediate: true }, budget: { weeklyTokenLimit: 10000, weeklyWindowDays: 7 }, quota: { throttleAtUsedPercent: 90, throttleWhenUnavailable: false }, roles, appServerClientFactory: () => client };
}
function setup(client) {
  const root = mkdtempSync(join(tmpdir(), "planner-lineage-"));
  git(root, ["init", "-b", "main"]); mkdirSync(join(root, "src")); mkdirSync(join(root, "docs", "orchestration-input"), { recursive: true }); const path = "requirements.md"; const file = { documentId: documentIdForPath(path), path, sha256: createHash("sha256").update("Fix value.\n").digest("hex") }; writeFileSync(join(root, "docs", "orchestration-input", path), "Fix value.\n"); writeFileSync(join(root, "docs", "orchestration-input", "inventory.json"), JSON.stringify({ files: [file], documentSetDigest: documentSetDigest([file]) })); writeFileSync(join(root, "src", "base.mjs"), "export const base = true;\n"); writeFileSync(join(root, "package.json"), JSON.stringify({ packageManager: "npm@10", scripts: {} })); writeFileSync(join(root, "package-lock.json"), "{}"); git(root, ["add", "."]); git(root, ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "base"]); return root;
}

test("planner writer edge propagates artifact worktree lineage and integration order", async () => {
  const plan = { blueprintId: "pb-test", tasks: [writer("writer-a", "Write A"), writer("writer-b", "Write B", ["writer-a"])] }; const client = new LineageClient(plan); const root = setup(client); let router;
  try {
    router = new SwarmRouter(config(root, client)); await router.ensureProjectOverlay(); router.startProject(); await router.runUntilIdle();
    const a = router.list().find((task) => task.title === "Write A"); const b = router.list().find((task) => task.title === "Write B"); const aArtifact = router.store.workerArtifact(a.id); const bArtifact = router.store.workerArtifact(b.id); assert.ok(aArtifact && bArtifact, JSON.stringify(router.list().map((task) => ({ title: task.title, role: task.role, status: task.status, error: task.error }))));
    const lineage = JSON.stringify({ writerBase: client.writerBases.get("writer-b"), artifactBase: b.artifactBaseSha, artifactDependencies: b.artifactDependencies, a: aArtifact.headSha }); assert.equal(client.writerBases.get("writer-b"), aArtifact.headSha, lineage); assert.equal(b.artifactBaseSha, aArtifact.headSha, lineage); assert.deepEqual(b.artifactDependencies, [a.id]); assert.deepEqual(bArtifact.dependencies, [a.id]);
    const integration = await router.integrateFinalized([b.id, a.id]); assert.deepEqual(integration.manifest.appliedArtifacts, [a.id, b.id]);
  } finally { router?.close(); rmSync(root, { recursive: true, force: true }); }
});

test("controller-owned barrier turns writer fan-in into a verified checkpoint baseline", async () => {
  const plan = { blueprintId: "pb-test", tasks: [writer("writer-a", "Write A"), writer("writer-c", "Write C"), writer("writer-b", "Write B", ["writer-a", "writer-c"])] }; const client = new LineageClient(plan); const root = setup(client); let router;
  try {
    router = new SwarmRouter(config(root, client)); await router.ensureProjectOverlay(); router.startProject(); await router.runUntilIdle();
    const b = router.list().find((task) => task.title === "Write B"); const barrier = router.store.integrationBarrier(b.integrationBarrierId); const checkpoint = router.store.integrationCheckpoint(barrier.checkpointId);
    assert.equal(barrier.status, "passed"); assert.equal(checkpoint.status, "passed"); assert.equal(client.writerBases.get("writer-b"), checkpoint.outputSha); assert.equal(b.artifactBaseSha, checkpoint.outputSha); assert.deepEqual(router.store.workerArtifact(b.id).dependencies, []);
  } finally { router?.close(); rmSync(root, { recursive: true, force: true }); }
});
