import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeliveryCoordinator } from "../src/delivery-coordinator.mjs";
import { SwarmRouter } from "../src/router.mjs";

const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const packageJson = () => JSON.stringify({ packageManager: "npm@10", scripts: { build: "node -e \"\"", test: "node -e \"\"" } });

class ScaffoldRepairClient extends EventEmitter {
  constructor() { super(); this.next = 0; this.threads = new Map(); this.scaffoldTurns = 0; }
  async connect() {} shutdown() {} diagnostics() { return { protocolEvents: [], stderrTail: "", process: {} }; }
  async request(method) { return method === "account/read" ? { account: {} } : method === "account/usage/read" ? { dailyUsageBuckets: [] } : { rateLimits: null }; }
  async startThread({ cwd }) { const id = `thread-${++this.next}`; this.threads.set(id, { cwd, goal: "", turns: 0 }); return { thread: { id } }; }
  async setGoal({ threadId, objective }) { this.threads.get(threadId).goal = objective; }
  async startTurn({ threadId }) { const thread = this.threads.get(threadId); thread.turns += 1; return { turn: { id: `${threadId}-turn-${thread.turns}` } }; }
  async waitForTurn(threadId, turnId) {
    const thread = this.threads.get(threadId);
    if (/^Scaffold product roots/.test(thread.goal)) {
      this.scaffoldTurns += 1;
      const root = this.scaffoldTurns === 1 ? "frontend" : "admin";
      mkdirSync(join(thread.cwd, root), { recursive: true });
      writeFileSync(join(thread.cwd, root, "package.json"), packageJson());
      writeFileSync(join(thread.cwd, root, "package-lock.json"), "{}");
    }
    return { id: turnId, status: "completed" };
  }
  async readThread({ threadId }) {
    const thread = this.threads.get(threadId);
    const text = /^Bootstrap/.test(thread.goal)
      ? "```json\n{\"summary\":\"ok\",\"assumptions\":[],\"risks\":[],\"humanGates\":[]}\n```"
      : /^Plan /.test(thread.goal)
        ? "```json\n{\"tasks\":[{\"id\":\"scaffold-product\",\"title\":\"Scaffold product roots\",\"prompt\":\"Create every root\",\"primaryDomain\":\"devops\",\"supportingDomains\":[\"security\"],\"riskFlags\":[\"dependency_supply_chain\"],\"humanApprovalRequired\":false,\"estimatedTokens\":20,\"dependsOn\":[],\"allowedPaths\":[\"frontend\"],\"acceptanceChecks\":[\"roots exist\"]}]}\n```"
        : /^Security review:/.test(thread.goal)
          ? "```json\n{\"verdict\":\"pass\",\"summary\":\"ok\",\"findings\":[],\"executedChecks\":[],\"notRunChecks\":[]}\n```"
          : /^QA:/.test(thread.goal)
            ? "```json\n{\"verdict\":\"pass\",\"summary\":\"ok\",\"findings\":[],\"executedChecks\":[],\"notRunChecks\":[]}\n```"
            : "scaffold complete";
    return { thread: { turns: [{ id: `${threadId}-turn-${thread.turns}`, items: [{ type: "agentMessage", text }] }] } };
  }
}

class HangingCompleteScaffoldClient extends ScaffoldRepairClient {
  constructor() { super(); this.interrupts = 0; }
  async waitForTurn(threadId, turnId) {
    const thread = this.threads.get(threadId);
    if (/^Scaffold product roots/.test(thread.goal)) {
      for (const root of ["frontend", "admin"]) {
        mkdirSync(join(thread.cwd, root), { recursive: true });
        writeFileSync(join(thread.cwd, root, "package.json"), packageJson());
        writeFileSync(join(thread.cwd, root, "package-lock.json"), "{}");
      }
      return new Promise(() => {});
    }
    return { id: turnId, status: "completed" };
  }
  async interruptTurn() { this.interrupts += 1; return {}; }
}

class HangingPartialScaffoldClient extends ScaffoldRepairClient {
  constructor() { super(); this.interrupts = 0; }
  async waitForTurn(threadId, turnId) {
    const thread = this.threads.get(threadId);
    if (/^Scaffold product roots/.test(thread.goal)) {
      const root = thread.turns === 1 ? "frontend" : "admin";
      mkdirSync(join(thread.cwd, root), { recursive: true });
      writeFileSync(join(thread.cwd, root, "package.json"), packageJson());
      writeFileSync(join(thread.cwd, root, "package-lock.json"), "{}");
      if (thread.turns === 1) return new Promise(() => {});
    }
    return { id: turnId, status: "completed" };
  }
  async interruptTurn() { this.interrupts += 1; return {}; }
}

class HangingNoProgressScaffoldClient extends ScaffoldRepairClient {
  constructor() { super(); this.interrupts = 0; }
  async waitForTurn(threadId, turnId) {
    const thread = this.threads.get(threadId);
    if (/^Scaffold product roots/.test(thread.goal)) {
      if (thread.turns === 1) return new Promise(() => {});
      for (const root of ["frontend", "admin"]) {
        mkdirSync(join(thread.cwd, root), { recursive: true });
        writeFileSync(join(thread.cwd, root, "package.json"), packageJson());
        writeFileSync(join(thread.cwd, root, "package-lock.json"), "{}");
      }
    }
    return { id: turnId, status: "completed" };
  }
  async interruptTurn() { this.interrupts += 1; return {}; }
}

test("incomplete scaffold is repaired in its existing worker thread and finalizes one artifact", async () => {
  const root = mkdtempSync(join(tmpdir(), "scaffold-repair-")); const source = join(root, "requirements"); const client = new ScaffoldRepairClient(); let router;
  try {
    git(root, ["init", "-b", "main"]); mkdirSync(source); writeFileSync(join(source, "spec.md"), "# Product\nScaffold both roots."); writeFileSync(join(root, "package.json"), packageJson()); writeFileSync(join(root, "package-lock.json"), "{}"); git(root, ["add", "."]); git(root, ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "base"]);
    const roles = Object.fromEntries(["bootstrap", "planner", "backend", "frontend", "database", "qa", "security", "devops"].map((role) => [role, { sandbox: role === "devops" ? "workspace-write" : "read-only", approvalPolicy: "never", tokenBudget: 100, usesWorktree: role === "devops" }]));
    router = new SwarmRouter({ repository: root, runtimeDir: join(root, "runtime"), baseRef: "main", model: "fake", project: { name: "repair", documentationDir: "docs/orchestration-input", generatedDir: "docs/orchestration-generated", productRoots: [{ id: "frontend", path: "frontend", adapter: "next-node" }, { id: "admin", path: "admin", adapter: "next-node" }] }, router: { maxConcurrentTasks: 2, maxChildrenPerTask: 20, maxDelegationDepth: 5, maxPlanTasks: 5, defaultParentBudget: 1000, turnTimeoutMs: 1000, approvalMode: "deny" }, autonomy: { mode: "autonomous", autoApproveWorkflowGates: true, autoRemediate: true, autoPush: false, autoCreatePullRequest: false, autoMerge: false, maxRemediationRounds: 2 }, budget: { weeklyTokenLimit: 10000, weeklyWindowDays: 7, enforceLocalLimits: false }, quota: { throttleAtUsedPercent: 90, throttleWhenUnavailable: false }, delivery: { maxRemediationRounds: 2 }, remote: { enabled: false, remoteName: "origin", allowedRemotes: ["origin"], candidateBranchPrefix: "swarm/candidate/", requireCi: false, mergeMethod: "merge" }, roles, appServerClientFactory: () => client });
    await new DeliveryCoordinator(router).begin({ source });
    const scaffold = router.list().find((task) => task.title === "Scaffold product roots");
    assert.equal(scaffold.status, "done");
    assert.equal(client.scaffoldTurns, 2);
    assert.ok(router.store.workerArtifact(scaffold.id));
    assert.equal(router.lifecycleEvents().some((event) => event.type === "scaffold completion retry"), true);
  } finally { router?.close(); rmSync(root, { recursive: true, force: true }); }
});

test("controller finalizes a verified scaffold even when the App Server worker never completes its turn", async () => {
  const root = mkdtempSync(join(tmpdir(), "scaffold-watchdog-")); const source = join(root, "requirements"); const client = new HangingCompleteScaffoldClient(); let router;
  try {
    git(root, ["init", "-b", "main"]); mkdirSync(source); writeFileSync(join(source, "spec.md"), "# Product\nScaffold both roots."); writeFileSync(join(root, "package.json"), packageJson()); writeFileSync(join(root, "package-lock.json"), "{}"); git(root, ["add", "."]); git(root, ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "base"]);
    const roles = Object.fromEntries(["bootstrap", "planner", "backend", "frontend", "database", "qa", "security", "devops"].map((role) => [role, { sandbox: role === "devops" ? "workspace-write" : "read-only", approvalPolicy: "never", tokenBudget: 100, usesWorktree: role === "devops" }]));
    router = new SwarmRouter({ repository: root, runtimeDir: join(root, "runtime"), baseRef: "main", model: "fake", project: { name: "watchdog", documentationDir: "docs/orchestration-input", generatedDir: "docs/orchestration-generated", productRoots: [{ id: "frontend", path: "frontend", adapter: "next-node" }, { id: "admin", path: "admin", adapter: "next-node" }] }, router: { maxConcurrentTasks: 2, maxChildrenPerTask: 20, maxDelegationDepth: 5, maxPlanTasks: 5, defaultParentBudget: 1000, turnTimeoutMs: 5000, scaffoldCompletionPollMs: 250, approvalMode: "deny" }, autonomy: { mode: "autonomous", autoApproveWorkflowGates: true, autoRemediate: true, autoPush: false, autoCreatePullRequest: false, autoMerge: false, maxRemediationRounds: 2 }, budget: { weeklyTokenLimit: 10000, weeklyWindowDays: 7, enforceLocalLimits: false }, quota: { throttleAtUsedPercent: 90, throttleWhenUnavailable: false }, delivery: { maxRemediationRounds: 2 }, remote: { enabled: false, remoteName: "origin", allowedRemotes: ["origin"], candidateBranchPrefix: "swarm/candidate/", requireCi: false, mergeMethod: "merge" }, roles, appServerClientFactory: () => client });
    await new DeliveryCoordinator(router).begin({ source });
    const scaffold = router.list().find((task) => task.title === "Scaffold product roots");
    assert.equal(scaffold.status, "done");
    assert.equal(client.interrupts, 1);
    assert.ok(router.store.workerArtifact(scaffold.id));
    assert.equal(router.lifecycleEvents().some((event) => event.type === "scaffold accepted from worktree"), true);
  } finally { router?.close(); rmSync(root, { recursive: true, force: true }); }
});

test("controller interrupts partial scaffold progress and corrects only the missing root in the same thread", async () => {
  const root = mkdtempSync(join(tmpdir(), "scaffold-partial-watchdog-")); const source = join(root, "requirements"); const client = new HangingPartialScaffoldClient(); let router;
  try {
    git(root, ["init", "-b", "main"]); mkdirSync(source); writeFileSync(join(source, "spec.md"), "# Product\nScaffold both roots."); writeFileSync(join(root, "package.json"), packageJson()); writeFileSync(join(root, "package-lock.json"), "{}"); git(root, ["add", "."]); git(root, ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "base"]);
    const roles = Object.fromEntries(["bootstrap", "planner", "backend", "frontend", "database", "qa", "security", "devops"].map((role) => [role, { sandbox: role === "devops" ? "workspace-write" : "read-only", approvalPolicy: "never", tokenBudget: 100, usesWorktree: role === "devops" }]));
    router = new SwarmRouter({ repository: root, runtimeDir: join(root, "runtime"), baseRef: "main", model: "fake", project: { name: "partial-watchdog", documentationDir: "docs/orchestration-input", generatedDir: "docs/orchestration-generated", productRoots: [{ id: "frontend", path: "frontend", adapter: "next-node" }, { id: "admin", path: "admin", adapter: "next-node" }] }, router: { maxConcurrentTasks: 2, maxChildrenPerTask: 20, maxDelegationDepth: 5, maxPlanTasks: 5, defaultParentBudget: 1000, turnTimeoutMs: 5000, scaffoldCompletionPollMs: 250, scaffoldPartialGraceMs: 250, approvalMode: "deny" }, autonomy: { mode: "autonomous", autoApproveWorkflowGates: true, autoRemediate: true, autoPush: false, autoCreatePullRequest: false, autoMerge: false, maxRemediationRounds: 2 }, budget: { weeklyTokenLimit: 10000, weeklyWindowDays: 7, enforceLocalLimits: false }, quota: { throttleAtUsedPercent: 90, throttleWhenUnavailable: false }, delivery: { maxRemediationRounds: 2 }, remote: { enabled: false, remoteName: "origin", allowedRemotes: ["origin"], candidateBranchPrefix: "swarm/candidate/", requireCi: false, mergeMethod: "merge" }, roles, appServerClientFactory: () => client });
    await new DeliveryCoordinator(router).begin({ source });
    const scaffold = router.list().find((task) => task.title === "Scaffold product roots");
    assert.equal(scaffold.status, "done");
    assert.equal(client.interrupts, 1);
    assert.equal(client.scaffoldTurns, 0);
    assert.equal(router.lifecycleEvents().some((event) => event.type === "scaffold partial progress interrupted"), true);
  } finally { router?.close(); rmSync(root, { recursive: true, force: true }); }
});

test("controller interrupts a no-progress scaffold turn and retries in the same thread", async () => {
  const root = mkdtempSync(join(tmpdir(), "scaffold-no-progress-watchdog-")); const source = join(root, "requirements"); const client = new HangingNoProgressScaffoldClient(); let router;
  try {
    git(root, ["init", "-b", "main"]); mkdirSync(source); writeFileSync(join(source, "spec.md"), "# Product\nScaffold both roots."); writeFileSync(join(root, "package.json"), packageJson()); writeFileSync(join(root, "package-lock.json"), "{}"); git(root, ["add", "."]); git(root, ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "base"]);
    const roles = Object.fromEntries(["bootstrap", "planner", "backend", "frontend", "database", "qa", "security", "devops"].map((role) => [role, { sandbox: role === "devops" ? "workspace-write" : "read-only", approvalPolicy: "never", tokenBudget: 100, usesWorktree: role === "devops" }]));
    router = new SwarmRouter({ repository: root, runtimeDir: join(root, "runtime"), baseRef: "main", model: "fake", project: { name: "no-progress-watchdog", documentationDir: "docs/orchestration-input", generatedDir: "docs/orchestration-generated", productRoots: [{ id: "frontend", path: "frontend", adapter: "next-node" }, { id: "admin", path: "admin", adapter: "next-node" }] }, router: { maxConcurrentTasks: 2, maxChildrenPerTask: 20, maxDelegationDepth: 5, maxPlanTasks: 5, defaultParentBudget: 1000, turnTimeoutMs: 5000, scaffoldCompletionPollMs: 250, scaffoldNoProgressGraceMs: 250, approvalMode: "deny" }, autonomy: { mode: "autonomous", autoApproveWorkflowGates: true, autoRemediate: true, autoPush: false, autoCreatePullRequest: false, autoMerge: false, maxRemediationRounds: 2 }, budget: { weeklyTokenLimit: 10000, weeklyWindowDays: 7, enforceLocalLimits: false }, quota: { throttleAtUsedPercent: 90, throttleWhenUnavailable: false }, delivery: { maxRemediationRounds: 2 }, remote: { enabled: false, remoteName: "origin", allowedRemotes: ["origin"], candidateBranchPrefix: "swarm/candidate/", requireCi: false, mergeMethod: "merge" }, roles, appServerClientFactory: () => client });
    await new DeliveryCoordinator(router).begin({ source });
    const scaffold = router.list().find((task) => task.title === "Scaffold product roots");
    assert.equal(scaffold.status, "done");
    assert.equal(client.interrupts, 1);
    assert.equal(router.lifecycleEvents().some((event) => event.type === "scaffold no-progress interrupted"), true);
  } finally { router?.close(); rmSync(root, { recursive: true, force: true }); }
});
