import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { SwarmRouter } from "../src/router.mjs";
import { assertObservedParallelTurns, assertParallelWorkerSmoke, assertSingleWorkerSmoke, formatE2eDiagnostics, preserveOrCleanupDisposableRoot, withE2eTimeout } from "../src/e2e-smoke.mjs";
import { openE2eRunReporter } from "../src/e2e-report.mjs";

const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const enabled = process.env.RUN_REAL_CODEX_E2E === "1";
const timeoutMs = Number(process.env.CODEX_E2E_TIMEOUT_MS ?? 180_000);
const workerCount = Number(process.env.CODEX_E2E_WORKERS ?? 1);

test("real Codex App Server smoke completes backend workers, artifacts, and integration", { skip: enabled ? false : "set RUN_REAL_CODEX_E2E=1 to intentionally spend account quota" }, async () => {
  assert.equal(Number.isInteger(timeoutMs) && timeoutMs >= 1_000, true, "CODEX_E2E_TIMEOUT_MS must be an integer of at least 1000");
  assert.equal(Number.isInteger(workerCount) && workerCount >= 1 && workerCount <= 10, true, "CODEX_E2E_WORKERS must be an integer from 1 to 10");
  const root = mkdtempSync(join(tmpdir(), "orchestration-real-e2e-"));
  let router;
  let taskId = null;
  let stage = "initializing";
  let timeoutRuntime = null;
  const reporter = process.env.E2E_REPORT_DIR ? openE2eRunReporter(process.env.E2E_REPORT_DIR) : null;
  let artifact = null;
  let integration = null;
  let succeeded = false;
  const observedLifecycle = [];
  const progress = (message, details = {}, reportType = message) => { stage = message; reporter?.event(reportType, details); console.log(`[E2E] ${message}`); };
  const diagnostics = (cause = null, runtime = timeoutRuntime) => {
    const task = taskId && router ? router.store.getTask(taskId) : null;
    return formatE2eDiagnostics({ stage, taskId, task, recoveryWorktree: task?.worktree, cause, runtime });
  };
  try {
    git(root, ["init", "-b", "main"]); mkdirSync(join(root, "src")); mkdirSync(join(root, "test"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ packageManager: "npm@10.0.0", scripts: { test: "node --test" } }), "utf8");
    for (let index = 1; index <= workerCount; index += 1) {
      writeFileSync(join(root, "src", `value-${index}.mjs`), "export const value = 1;\n", "utf8");
      writeFileSync(join(root, "test", `value-${index}.test.mjs`), `import test from 'node:test'; import assert from 'node:assert/strict'; import { value } from '../src/value-${index}.mjs'; test('fixed value ${index}', () => assert.equal(value, 2));\n`, "utf8");
    }
    git(root, ["add", "."]); git(root, ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "base"]);
    progress("repository created");
    const roles = Object.fromEntries(["bootstrap", "planner", "backend", "frontend", "database", "qa", "security", "devops"].map((role) => [role, { sandbox: role === "backend" ? "workspace-write" : "read-only", approvalPolicy: "never", tokenBudget: 12000, maxAttempts: 1, usesWorktree: role === "backend" }]));
    router = new SwarmRouter({ repository: root, runtimeDir: join(root, "runtime"), baseRef: "main", model: process.env.CODEX_E2E_MODEL ?? "gpt-5.6-terra", project: { name: "disposable-e2e", documentationDir: "docs/orchestration-input", generatedDir: "docs/orchestration-generated" }, router: { maxConcurrentTasks: workerCount, maxChildrenPerTask: workerCount, maxDelegationDepth: 2, maxPlanTasks: workerCount, defaultParentBudget: 20000, turnTimeoutMs: timeoutMs, approvalMode: "deny" }, budget: { weeklyTokenLimit: 50000, weeklyWindowDays: 7 }, quota: { throttleAtUsedPercent: 90, throttleWhenUnavailable: false }, roles });
    router.on("lifecycle", (event) => {
      observedLifecycle.push(event);
      const suffix = event.taskId ? `: ${event.taskId}` : "";
      progress(`${event.type}${suffix}`, event, event.type);
    });
    await router.ensureProjectOverlay();
    progress("overlay generated");
    const tasks = Array.from({ length: workerCount }, (_, offset) => {
      const index = offset + 1;
      const task = router.enqueue({ role: "backend", title: `Fix disposable value ${index}`, prompt: `Change only src/value-${index}.mjs so it exports value = 2. Do not modify tests, commit, push, or create agents. Run the declared test command.`, allowedPaths: [`src/value-${index}.mjs`], acceptanceChecks: ["npm run test"], estimatedTokens: 8000 });
      reporter?.event("backend task enqueued", { taskId: task.id });
      return task;
    });
    taskId = tasks[0].id;
    reporter?.setTask(tasks[0]);
    if (workerCount === 1) assertSingleWorkerSmoke(router.list());
    else assertParallelWorkerSmoke(router.list(), workerCount);
    progress(`${workerCount} backend task(s) enqueued`);
    await withE2eTimeout({
      timeoutMs,
      diagnostics: (runtime) => diagnostics(null, runtime),
      onTimeout: async () => {
        try { timeoutRuntime = taskId && router ? await router.collectTaskDiagnostics(taskId) : null; reporter?.setDiagnostics(timeoutRuntime); return timeoutRuntime; }
        finally { router?.stop(); }
      },
      operation: async () => {
        progress("App Server workers started");
        await router.runUntilIdle();
        const completed = tasks.map((task) => router.store.getTask(task.id));
        reporter?.setTask(completed[0]);
        if (completed.some((task) => task.status !== "done")) throw new Error(`One or more workers did not finish successfully. ${diagnostics()}`);
        if (workerCount > 1) {
          const overlap = assertObservedParallelTurns(observedLifecycle, 2);
          progress("parallel turns verified", { taskId, status: String(overlap.maximumConcurrentTurns) });
        }
        progress("workers completed");
        const artifacts = completed.map((task, offset) => {
          const artifactRecord = router.store.workerArtifactRecord(task.id);
          const finalized = artifactRecord ? { ...artifactRecord.artifact, path: artifactRecord.path } : null;
          assert.ok(finalized, "finalizer must create WorkerArtifact independently of agent report");
          assert.equal(finalized.changedPaths.includes(`src/value-${offset + 1}.mjs`), true);
          assert.equal(git(task.worktree, ["status", "--porcelain"]), "");
          progress("artifact finalized", { taskId: task.id, artifactPath: finalized.path });
          return finalized;
        });
        artifact = artifacts[0];
        progress("integration started", { taskId });
        integration = await router.integrateFinalized(tasks.map((task) => task.id));
        progress("integration manifest created", { taskId, integrationPath: integration.path, status: integration.manifest.status, candidateBranch: integration.manifest.branch ?? null });
        assert.equal(integration.manifest.status, "awaiting_human_merge");
        progress("integration verification started", { taskId, integrationPath: integration.path });
        execFileSync(process.execPath, ["--test"], { cwd: integration.manifest.worktree, stdio: "pipe", timeout: Math.min(timeoutMs, 30_000) });
        progress("integration verification completed");
        progress("integration completed", { taskId, integrationPath: integration.path, status: integration.manifest.status });
        reporter?.finalize({ status: "passed", task: router.store.getTask(taskId), artifact, integration, diagnostics: timeoutRuntime });
        succeeded = true;
      }
    });
  } catch (error) {
    console.log("[E2E] workers failed");
    const task = taskId && router ? router.store.getTask(taskId) : null;
    reporter?.event("failure", { taskId, status: task?.status ?? "failed", errorKind: "e2e failure" });
    reporter?.finalize({ status: "failed", task, artifact, integration, diagnostics: timeoutRuntime ?? router?.appServerDiagnostics(), error, recoveryRoot: root, recoveryAction: `Preserved failed disposable E2E root. Inspect it, then run npm run e2e:cleanup -- --recovery-root "${root}".` });
    throw new Error(`${error.message}\n${diagnostics(error)}`);
  } finally {
    const task = taskId && router ? router.store.getTask(taskId) : null;
    try { router?.stop(); } catch { /* best effort only */ }
    try { router?.close(); } catch { /* preserve the primary error */ }
    let recovery;
    try { recovery = preserveOrCleanupDisposableRoot(root, { passed: succeeded }); }
    catch { recovery = { recoveryRoot: succeeded ? root : null, recoveryAction: "Automatic disposable-root cleanup failed; inspect the explicitly named recovery root before manual cleanup." }; }
    if (reporter?.summary()?.status === "running") reporter.finalize({ status: "failed", task, artifact, integration, diagnostics: timeoutRuntime ?? router?.appServerDiagnostics(), recoveryRoot: recovery.recoveryRoot, recoveryAction: recovery.recoveryAction });
    else if (!succeeded) reporter?.update(recovery);
  }
});
