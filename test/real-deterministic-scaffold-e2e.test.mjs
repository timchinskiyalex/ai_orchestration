import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { SwarmRouter } from "../src/router.mjs";
import { assertObservedParallelTurns, formatE2eDiagnostics, preserveOrCleanupDisposableRoot, withE2eTimeout } from "../src/e2e-smoke.mjs";
import { openE2eRunReporter } from "../src/e2e-report.mjs";

const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const enabled = process.env.RUN_REAL_CODEX_E2E === "1";
const timeoutMs = Number(process.env.CODEX_E2E_TIMEOUT_MS ?? 240_000);
const reporter = process.env.E2E_REPORT_DIR ? openE2eRunReporter(process.env.E2E_REPORT_DIR) : null;
const productRoots = [{ id: "frontend", path: "frontend", adapter: "next-node" }, { id: "backend", path: "backend", adapter: "dotnet" }];

test("real App Server controlled E2E: deterministic scaffold, parallel writers, controller QA, and integration", { skip: enabled ? false : "set RUN_REAL_CODEX_E2E=1 to intentionally spend account quota" }, async () => {
  assert.equal(Number.isInteger(timeoutMs) && timeoutMs >= 1_000, true, "CODEX_E2E_TIMEOUT_MS must be an integer of at least 1000");
  const root = mkdtempSync(join(tmpdir(), "orchestration-real-greenfield-e2e-"));
  let router; let integration; let succeeded = false; let currentTaskId = null; const lifecycle = [];
  const progress = (stage, details = {}) => { console.log(`[E2E] ${stage}`); reporter?.event(stage, details); };
  const roles = Object.fromEntries(["bootstrap", "planner", "backend", "frontend", "database", "qa", "security", "devops"].map((role) => {
    const tokenBudget = role === "devops" ? 3_000 : ["backend", "frontend"].includes(role) ? 50_000 : 20_000;
    const interruptThresholdTokens = role === "devops" ? 2_000 : ["backend", "frontend"].includes(role) ? 45_000 : 16_000;
    return [role, { sandbox: ["backend", "frontend", "devops"].includes(role) ? "workspace-write" : "read-only", approvalPolicy: "never", tokenBudget, interruptThresholdTokens, usesWorktree: ["backend", "frontend", "devops"].includes(role) }];
  }));
  try {
    git(root, ["init", "-b", "main"]); mkdirSync(join(root, "docs", "project-specifications"), { recursive: true });
    writeFileSync(join(root, ".gitignore"), "runtime/\n**/bin/\n**/obj/\n**/node_modules/\n**/.next/\n");
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "controller-only", private: true }));
    writeFileSync(join(root, "docs", "project-specifications", "brief.md"), "# Disposable greenfield E2E\n");
    git(root, ["add", "."]); git(root, ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "base"]);
    // This E2E isolates successful controller lifecycle integration. The
    // quota-free suite separately exercises enforced thresholds and delayed
    // usage interrupts; the upstream protocol has no server-side turn cap.
    router = new SwarmRouter({ repository: root, runtimeDir: join(root, "runtime"), baseRef: "main", model: process.env.CODEX_E2E_MODEL ?? "gpt-5.6-terra", project: { name: "disposable-greenfield-e2e", documentationDir: "docs/orchestration-input", generatedDir: "docs/orchestration-generated", productRoots }, router: { maxConcurrentTasks: 2, maxChildrenPerTask: 12, maxDelegationDepth: 3, maxPlanTasks: 8, defaultParentBudget: 120_000, turnTimeoutMs: timeoutMs, approvalMode: "deny" }, autonomy: { mode: "autonomous", autoApproveWorkflowGates: true, autoRemediate: true, autoPush: false, autoCreatePullRequest: false, autoMerge: false, maxRemediationRounds: 1 }, budget: { weeklyTokenLimit: 180_000, weeklyWindowDays: 7, hardRunTokenLimit: 150_000, interruptSafetyMarginTokens: 1_000, enforceLocalLimits: false }, quota: { throttleAtUsedPercent: 90, throttleWhenUnavailable: false }, delivery: { maxRemediationRounds: 1, shutdownGraceMs: 3_000 }, remote: { enabled: false, remoteName: "origin", allowedRemotes: ["origin"], candidateBranchPrefix: "swarm/candidate/", requireCi: false, mergeMethod: "merge" }, roles });
    router.on("lifecycle", (event) => { lifecycle.push(event); progress(event.type, event); });
    await router.ensureProjectOverlay();
    const scaffold = router.enqueue({ role: "devops", title: "Scaffold product roots", prompt: "[[product-scaffold]] Create the controller-owned declared product roots.", allowedPaths: ["frontend", "backend"], acceptanceChecks: ["frontend and backend scaffolded"], estimatedTokens: 1_000 });
    const frontend = router.enqueue({ role: "frontend", title: "Add frontend E2E marker", prompt: "Create only frontend/app/e2e-marker.tsx exporting a simple React component named E2eMarker. Do not create agents, commits, or explanations; finish the file and return the structured result.", allowedPaths: ["frontend/app/e2e-marker.tsx"], acceptanceChecks: ["frontend marker exists"], dependencies: [scaffold.id], estimatedTokens: 4_000 });
    const backend = router.enqueue({ role: "backend", title: "Add backend E2E marker", prompt: "Create only backend/src/Backend.Api/E2eMarker.cs containing a valid simple static C# class named E2eMarker. Do not create agents, commits, or explanations; finish the file and return the structured result.", allowedPaths: ["backend/src/Backend.Api/E2eMarker.cs"], acceptanceChecks: ["backend marker exists"], dependencies: [scaffold.id], estimatedTokens: 4_000 });
    currentTaskId = scaffold.id; progress("tasks enqueued", { scaffold: scaffold.id, frontend: frontend.id, backend: backend.id });
    await withE2eTimeout({ timeoutMs, operation: async () => {
      const execution = await router.runUntilIdle();
      if (execution.blockedQuota) throw new Error("blocked_quota: App Server account quota refused the controlled E2E");
      if (execution.blockedBudget) throw new Error("blocked_budget: the controlled E2E reached its configured local guardrail");
      if (execution.failed || execution.interrupted) throw new Error("controlled E2E worker lifecycle did not reach a successful terminal state");
    }, diagnostics: (runtime) => formatE2eDiagnostics({ stage: "workers", taskId: currentTaskId, task: router.store.getTask(currentTaskId), runtime }), onTimeout: async () => { const diagnostics = await router.collectTaskDiagnostics(currentTaskId); reporter?.setDiagnostics(diagnostics); await router.requestShutdown("interrupted_controller_exit: controlled E2E timeout"); return diagnostics; } });
    const tasks = [scaffold, frontend, backend].map((task) => router.store.getTask(task.id));
    assert.equal(tasks.every((task) => task.status === "done"), true, "all deterministic scaffold and writer tasks must pass");
    assert.equal(router.store.workerArtifact(scaffold.id) !== null, true);
    assert.equal(lifecycle.some((event) => event.type === "turn started" && event.taskId === scaffold.id), false, "scaffold must not spend an App Server turn");
    assertObservedParallelTurns(lifecycle, 2);
    const artifacts = [scaffold, frontend, backend].map((task) => router.store.workerArtifact(task.id));
    assert.equal(artifacts.every((artifact) => artifact.verificationResults.every((result) => result.status === "passed")), true, "controller QA verification must pass for every artifact");
    progress("controller QA/local verification passed");
    integration = await router.integrateFinalized([scaffold.id, frontend.id, backend.id]);
    assert.equal(integration.manifest.status, "candidate_ready");
    progress("integration passed", { candidateBranch: integration.manifest.branch, integrationPath: integration.path });
    reporter?.finalize({ status: "passed", task: router.store.getTask(frontend.id), artifact: router.store.workerArtifact(frontend.id), integration, diagnostics: router.appServerDiagnostics() });
    succeeded = true;
  } catch (error) {
    const task = currentTaskId && router ? router.store.getTask(currentTaskId) : null;
    reporter?.finalize({ status: "failed", task, integration, diagnostics: router?.appServerDiagnostics(), error, recoveryRoot: root, recoveryAction: `Preserved disposable E2E root: ${root}` });
    throw error;
  } finally {
    try { router?.stop(); router?.close(); } catch { /* preserve the primary result */ }
    const recovery = preserveOrCleanupDisposableRoot(root, { passed: succeeded });
    if (!succeeded) reporter?.update(recovery);
  }
});
