import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { AppServerClient } from "./app-server-client.mjs";
import { BudgetGovernor } from "./budget-governor.mjs";
import { depthOf, finalStatusForRole, assertRole, ENGINEERING_DOMAINS } from "./domain.mjs";
import { StateStore } from "./state-store.mjs";
import { WorktreeManager } from "./worktree-manager.mjs";
import { extractOrchestrationJson, validateBootstrap, validatePlan, validateIntegrationCheckpoint } from "./workflow-contract.mjs";
import { BudgetAccountAdapter } from "./budget-account-adapter.mjs";
import { commandCwd, commandsForPaths, generateProjectOverlay, loadProjectOverlay, projectOverlayExecutionSnapshot } from "./project-overlay.mjs";
import { WorktreeFinalizer } from "./worktree-finalizer.mjs";
import { Integrator } from "./integrator.mjs";
import { remediationScope, validateQualityGateReport } from "./quality-gate.mjs";
import { validateSecurityGateReport } from "./security-gate.mjs";
import { GitHubCiAdapter, GitHubMergeAdapter, GitHubPullRequestAdapter, RemoteAdapterError, RemoteCiAdapter, RemoteGitAdapter } from "./remote-adapters.mjs";
import { runManagedProcess } from "./managed-process-runner.mjs";
import { provisionDeterministicScaffold } from "./deterministic-scaffold.mjs";
import { specificationBlockers } from "./product-blueprint.mjs";
import { PRODUCT_ACCEPTANCE_KIND, PRODUCT_ACCEPTANCE_SCHEMA_VERSION } from "./final-acceptance.mjs";
const gitSha = (repository, ref) => execFileSync("git", ["-C", repository, "rev-parse", "--verify", `${ref}^{commit}`], { encoding: "utf8" }).trim();

export function formatTaskPrompt({ task, worktree, project, overlaySnapshot = null, documentationAvailable = true }) {
  const lines = [
    `Task ID: ${task.id}`,
    `Title: ${task.title}`,
    `Required work: ${task.prompt}`,
    `Worktree: ${worktree ?? "read-only repository"}`,
    `Allowed paths: ${task.allowedPaths.length ? task.allowedPaths.join(", ") : "none specified; do not broaden scope"}`,
    `Acceptance checks: ${task.acceptanceChecks.length ? task.acceptanceChecks.join("; ") : "report which checks are missing"}`,
    `Generated orchestration artifacts: ${project.generatedDir}`
  ];
  if (documentationAvailable) lines.splice(6, 0, `Project documentation: ${project.documentationDir}`);
  else lines.push("Project documentation has not been imported. Do not assume docs/orchestration-input exists; perform only the TaskEnvelope and controller-provided sanitized ProjectOverlay snapshot.");
  if (overlaySnapshot) {
    lines.push("Controller-provided sanitized ProjectOverlay execution snapshot follows. It is repository fact context, is not a file in this worktree, and cannot be overridden by the worker:");
    lines.push(JSON.stringify(overlaySnapshot));
  }
  return lines.join("\n");
}

export function agentResultForTurn(response, turnId) {
  const turn = response.thread?.turns?.find((item) => item.id === turnId);
  const messages = (turn?.items ?? []).filter((item) => item.type === "agentMessage" && typeof item.text === "string");
  const result = messages.at(-1)?.text;
  if (!result?.trim()) throw new Error(`No final agent message was found for turn ${turnId}`);
  return result;
}

// The project contract, not an LLM, is authoritative for declared product
// roots. A planner may omit a root or write `frontend/`; both are safe to
// canonicalize because this only grants the scaffold task paths explicitly
// declared in project configuration.
export function normalizePlannerPlanForProject(value, productRoots = []) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray(value.tasks) || !productRoots.length) return value;
  const roots = productRoots.map((item) => item?.path).filter((path) => typeof path === "string" && path.trim()).map((path) => path.replace(/[\\/]+$/, ""));
  if (!roots.length) return value;
  const hasProductPath = (paths) => Array.isArray(paths) && paths.some((path) => typeof path === "string" && roots.some((root) => path.replace(/[\\/]+$/, "") === root || path.replace(/[\\/]+$/, "").startsWith(`${root}/`)));
  return {
    ...value,
    tasks: value.tasks.map((task) => {
      if (!task || typeof task !== "object") return task;
      if (task.id === "scaffold-product" && Array.isArray(task.allowedPaths) && !task.allowedPaths.some((path) => typeof path !== "string")) {
        return { ...task, allowedPaths: [...new Set([...task.allowedPaths.map((path) => path.replace(/[\\/]+$/, "")), ...roots])] };
      }
      if (task.id !== "scaffold-product" && hasProductPath(task.allowedPaths) && Array.isArray(task.dependsOn) && !task.dependsOn.includes("scaffold-product")) {
        return { ...task, dependsOn: [...task.dependsOn, "scaffold-product"] };
      }
      return task;
    })
  };
}

export class SwarmRouter extends EventEmitter {
  constructor(config, { readOnly = false } = {}) {
    super();
    this.config = config;
    this.store = new StateStore(join(config.runtimeDir, "swarm.sqlite"), { readOnly });
    this.governor = new BudgetGovernor(config.router);
    this.worktrees = new WorktreeManager(config);
    this.threadTasks = new Map();
    this.account = new BudgetAccountAdapter(this.store);
    this.processRunner = config.processRunner ?? runManagedProcess;
    this.finalizer = new WorktreeFinalizer({ repository: config.repository, generatedDir: config.project.generatedDir, autonomy: config.autonomy, processRunner: this.processRunner });
    this.lifecycleTrace = [];
    this.lastAppServerDiagnostics = null;
    this.lifecyclePath = join(config.runtimeDir, "lifecycle.jsonl");
    this.activeDeliveryRunId = null;
    this.activeDeliverySessionId = null;
    this.stopRequested = false;
    this.expectedClientShutdown = false;
    this.budgetInterruptedTasks = new Set();
    this.pendingBudgetWatchdogs = new Set();
    this.activeTurns = new Map();
    this.closed = false;
  }

  init() {
    mkdirSync(this.config.runtimeDir, { recursive: true });
    return { runtimeDir: this.config.runtimeDir, database: join(this.config.runtimeDir, "swarm.sqlite") };
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.stop();
    this.store.close();
  }

  stop() {
    if (this.activeClient) this.lastAppServerDiagnostics = this.activeClient.diagnostics();
    this.activeClient?.shutdown()?.catch?.(() => {});
  }

  async requestShutdown(reason = "interrupted_controller_exit") {
    if (this.stopRequested) return;
    this.stopRequested = true;
    const client = this.activeClient;
    const active = [...this.activeTurns.values()];
    this.#lifecycle("controller shutdown requested", { reason, activeTurns: active.map(({ taskId, threadId, turnId }) => ({ taskId, threadId, turnId })) });
    if (client) {
      await Promise.allSettled(active.map((turn) => this.#interruptAndAwaitTurn(client, turn, reason, { timeoutMs: this.config.delivery?.shutdownGraceMs ?? 3_000 })));
    }
    this.#markInterrupted(reason, { activeTurns: active.map(({ taskId, threadId, turnId }) => ({ taskId, threadId, turnId })) });
    await client?.shutdown();
  }

  #markInterrupted(reason, recovery = {}) {
    if (!this.activeDeliveryRunId) {
      for (const active of this.activeTurns.values()) {
        const task = this.store.getTask(active.taskId);
        if (task?.status === "running") this.store.transition(task.id, "interrupted", { error: reason });
      }
      return null;
    }
    const run = this.store.deliveryRun(this.activeDeliveryRunId);
    if (run && !["interrupted", "completed_merged", "failed", "blocked_budget", "blocked_specification", "blocked_quota", "blocked_credentials", "blocked_ci", "blocked_branch_protection", "conflict_blocked"].includes(run.state)) return this.store.interruptDeliveryRun(run.id, { reason, recovery });
    return run;
  }

  recoverStaleDeliveries() {
    const staleAfterMs = this.config.delivery?.staleLeaseMs ?? 30_000;
    const recovered = this.store.recoverStaleDeliveryRuns({ staleAfterMs, isProcessAlive: (pid) => {
      try { process.kill(pid, 0); return true; } catch { return false; }
    } });
    for (const run of recovered) this.#lifecycle("stale delivery recovered", { deliveryRunId: run.id, state: run.state, recovery: run.recovery });
    return recovered;
  }

  activateDeliveryRun(runId, sessionId = undefined) {
    const sameRun = this.activeDeliveryRunId === runId;
    this.activeDeliveryRunId = runId;
    if (sessionId !== undefined) this.activeDeliverySessionId = sessionId;
    else if (!sameRun) this.activeDeliverySessionId = null;
  }

  createDeliveryRun(details) {
    const sessionId = randomUUID();
    const run = this.store.createDeliveryRun({ ...details, ownerPid: process.pid, ownerSessionId: sessionId });
    this.activateDeliveryRun(run.id, sessionId);
    return run;
  }

  resumeDeliveryRun(id) {
    const sessionId = randomUUID();
    const run = this.store.resumeDeliveryRun(id, { ownerPid: process.pid, ownerSessionId: sessionId });
    this.activateDeliveryRun(run.id, sessionId);
    return run;
  }

  lifecycleEvents() { return [...this.lifecycleTrace]; }

  appServerDiagnostics() {
    return {
      lifecycleEvents: this.lifecycleEvents(),
      appServer: this.activeClient?.diagnostics() ?? this.lastAppServerDiagnostics ?? null
    };
  }

  async collectTaskDiagnostics(taskId, { threadReadTimeoutMs = 1_500 } = {}) {
    const task = this.store.getTask(taskId);
    let threadRead = { available: false, reason: "thread/read unavailable" };
    if (task?.threadId && task.turnId && this.activeClient && !this.activeClient.closed) {
      try {
        threadRead = (await this.activeClient.readTerminalTurn(task.threadId, task.turnId, threadReadTimeoutMs)).summary;
      } catch {
        threadRead = { available: false, threadId: task.threadId, turnId: task.turnId, error: "thread/read failed" };
      }
    }
    return { task, threadRead, ...this.appServerDiagnostics() };
  }

  enqueue({ role, title, prompt, parentTaskId = null, allowedPaths = [], acceptanceChecks = [], dependencies = [], estimatedTokens = null, humanApprovalRequired = false, riskFlags = [], supportingDomains = [], artifactBaseSha = null, artifactDependencies = [], remediationRound = 0, sourceWriterTaskId = null, blueprintId = null, requirementIds = [], deliveryRunId = this.activeDeliveryRunId }) {
    assertRole(role);
    if (!title?.trim() || !prompt?.trim()) throw new Error("title and prompt are required");
    const roleConfig = this.config.roles[role];
    const estimate = estimatedTokens ?? roleConfig.tokenBudget;
    if (!Number.isInteger(estimate) || estimate < 1 || estimate > roleConfig.tokenBudget) throw new Error(`Invalid token estimate for ${role}; it must be between 1 and ${roleConfig.tokenBudget}`);
    if (parentTaskId) this.#validateChild(parentTaskId);
    this.#validateDependencies(dependencies);
    return this.store.createTask({
      id: randomUUID(), parentTaskId, role, title: title.trim(), prompt: prompt.trim(),
      allowedPaths, acceptanceChecks, dependencies, humanApprovalRequired, estimatedTokens: estimate, tokenBudget: roleConfig.tokenBudget, maxAttempts: 1,
      riskFlags, supportingDomains, artifactBaseSha, artifactDependencies, remediationRound, sourceWriterTaskId, blueprintId, requirementIds, deliveryRunId
    });
  }

  list() { return this.store.listTasks(); }

  statusSnapshot() {
    const readiness = this.executionReadiness();
    const tasks = this.list();
    const reports = tasks.filter((task) => task.role === "qa").map((task) => ({ taskId: task.id, ...this.store.qualityReport(task.id) })).filter((item) => item.report);
    const securityReports = tasks.filter((task) => task.role === "security").map((task) => ({ taskId: task.id, ...this.store.securityReport(task.id) })).filter((item) => item.report);
    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      tasks: tasks.map((task) => ({ id: task.id, title: task.title, role: task.role, status: task.status, dependencies: task.dependencies, blocker: task.error ?? null, tokenUsed: task.tokenUsed, estimatedTokens: task.estimatedTokens, tokenBudget: task.tokenBudget, interruptThresholdTokens: task.interruptThresholdTokens, configuredBudgetCap: task.configuredBudgetCap, budgetInterrupt: task.budgetInterrupt, threadId: task.threadId, turnId: task.turnId, worktree: task.worktree, remediationRound: task.remediationRound })),
      activeTurns: tasks.filter((task) => task.status === "running").map((task) => ({ taskId: task.id, threadId: task.threadId, turnId: task.turnId })),
      realConcurrency: tasks.filter((task) => task.status === "running").length,
      localBudget: readiness.localBudget,
      localBudgetEnforcement: this.#enforcesLocalBudget() ? "enforced" : "tracking_only",
      localForecast: readiness.localForecast,
      appServerQuotaWindows: readiness.accountQuota.quotaWindows ?? [],
      quotaThrottle: readiness.quotaThrottle,
      qualityReports: reports.map(({ taskId, path, report }) => ({ taskId, path, verdict: report.verdict, findings: report.findings.length })),
      securityReports: securityReports.map(({ taskId, path, report }) => ({ taskId, path, verdict: report.verdict, findings: report.findings.length })),
      deliveryRun: this.store.currentDeliveryRun(),
      finalAcceptance: this.store.currentDeliveryRun() ? this.store.productAcceptanceForRun(this.store.currentDeliveryRun().id) : null,
      lifecycle: this.store.recentEvents(20)
    };
  }

  budgetSummary() {
    const limit = this.config.budget.weeklyTokenLimit;
    const since = new Date(Date.now() - this.config.budget.weeklyWindowDays * 86_400_000).toISOString();
    const usage = this.store.weeklyUsageSince(since);
    const usedPercent = Number(((usage.used / limit) * 100).toFixed(2));
    const projectedPercent = Number((((usage.used + usage.estimate) / limit) * 100).toFixed(2));
    return {
      label: `local rolling ${this.config.budget.weeklyWindowDays}-day ${this.#enforcesLocalBudget() ? "budget" : "usage tracking"}`, windowStartedAt: since, weeklyTokenLimit: limit, usedTokens: usage.used,
      enforcement: this.#enforcesLocalBudget() ? "enforced" : "tracking_only",
      usedPercent, plannedTokens: usage.estimate, reservedTokens: usage.reserved,
      projectedTokens: usage.used + usage.estimate,
      projectedPercent, remainingTokens: Math.max(0, limit - usage.used),
      remainingPercent: Number((Math.max(0, (limit - usage.used) / limit * 100)).toFixed(2)),
      remainingAfterPlanTokens: Math.max(0, limit - usage.used - usage.estimate),
      remainingAfterPlanPercent: Number((Math.max(0, (limit - usage.used - usage.estimate) / limit * 100)).toFixed(2))
    };
  }

  accountSummary() { return this.store.latestAccountSnapshot() ?? { schemaVersion: 1, account: { availability: "not-yet-read" }, accountActivity: [], quotaWindows: [], diagnostics: [] }; }

  implementationForecast() {
    const tasks = this.store.listTasks().filter((task) => ENGINEERING_DOMAINS.has(task.role) && ["queued", "awaiting_human", "preparing", "running", "awaiting_approval"].includes(task.status));
    return this.account.forecast(tasks, this.store.completedTelemetry());
  }

  executionReadiness() {
    const budget = this.budgetSummary();
    const forecast = this.implementationForecast();
    return {
      localBudget: budget, localForecast: forecast,
      localUsedTokens: budget.usedTokens, localReservedTokens: budget.reservedTokens, localRemainingTokens: budget.remainingTokens,
      localUsedPercent: budget.usedPercent, localP90ProjectedTokens: budget.usedTokens + forecast.p90Tokens,
      localP90ProjectedPercent: Number((((budget.usedTokens + forecast.p90Tokens) / budget.weeklyTokenLimit) * 100).toFixed(2)),
      accountQuota: this.accountSummary(), quotaThrottle: this.quotaThrottleStatus()
    };
  }

  quotaThrottleStatus() {
    const account = this.accountSummary();
    const threshold = this.config.quota?.throttleAtUsedPercent ?? 90;
    const unavailable = account.account?.availability === "unavailable" || account.account?.availability === "not-yet-read";
    const windows = (account.quotaWindows ?? []).filter((window) => window.usedPercent >= threshold);
    return { threshold, throttled: windows.length > 0 || (unavailable && Boolean(this.config.quota?.throttleWhenUnavailable)), windows, reason: windows.length ? `App Server quota window reached ${threshold}%` : (unavailable ? "App Server quota unavailable" : null) };
  }

  async ensureProjectOverlay() {
    return generateProjectOverlay({ repository: this.config.repository, baseRef: this.config.baseRef, generatedDir: this.config.project.generatedDir, project: this.config.project });
  }

  async integrateFinalized(taskIds) {
    const ids = Array.isArray(taskIds) ? taskIds : [];
    if (!ids.length) throw new Error("Provide at least one finalized task id");
    if (new Set(ids).size !== ids.length) throw new Error("Integration task ids must be unique");
    const artifacts = ids.map((id) => {
      const task = this.store.getTask(id);
      if (!task) throw new Error(`Task ${id} has no finalized WorkerArtifact (task was not found)`);
      if (task.status !== "done") throw new Error(`Task ${id} must be done before integration (current status: ${task.status})`);
      const artifact = this.store.workerArtifact(id);
      if (!artifact) throw new Error(`Task ${id} has no finalized WorkerArtifact`);
      if (artifact.taskId !== task.id) throw new Error(`Task ${id} WorkerArtifact taskId does not match the task`);
      if (this.config.roles[task.role]?.sandbox === "workspace-write" && !this.#writerReviewPassed(task.id)) {
        throw new Error(`Task ${id} requires a passed Security and QA review chain before integration`);
      }
      return artifact;
    });
    const { overlay } = loadProjectOverlay(this.config.repository, this.config.project.generatedDir);
    const result = await new Integrator({ ...this.config, processRunner: this.processRunner }).integrate({ artifacts, overlay });
    this.store.recordIntegrationManifest(result.path, result.manifest);
    return result;
  }

  async publishCandidate(integration, { confirmRemotePush = false, remoteGitAdapter = null, pullRequestAdapter = null, remoteCiAdapter = null, mergeAdapter = null, acceptanceReportId = null } = {}) {
    const manifest = integration?.manifest;
    if (!manifest || !["candidate_ready", "awaiting_human_merge"].includes(manifest.status) || manifest.localVerification?.status !== "passed") return { terminalState: "conflict_blocked", status: "conflict_blocked", reason: manifest?.blockedReason ?? "No locally verified candidate integration manifest" };
    const run = this.activeDeliveryRunId ? this.store.deliveryRun(this.activeDeliveryRunId) : null;
    if (!run || !integration.path || this.store.integrationManifest(integration.path)?.id !== manifest.id || !run.blueprintId || !run.candidate || run.candidate.sha.toLowerCase() !== manifest.candidateSha?.toLowerCase()) return { terminalState: "conflict_blocked", status: "conflict_blocked", reason: "Publication requires the exact persisted delivery run, blueprint, candidate, and integration manifest." };
    const remote = this.config.remote ?? {};
    const autonomy = { mode: "autonomous", autoPush: true, autoCreatePullRequest: true, autoMerge: true, autoRemediate: true, ...(this.config.autonomy ?? {}) };
    const autonomous = this.isAutonomous();
    const auto = autonomous && autonomy.autoPush && autonomy.autoCreatePullRequest && autonomy.autoMerge;
    if (!remote.enabled || (!auto && !confirmRemotePush)) return { terminalState: autonomous ? "blocked_credentials" : "awaiting_human", status: autonomous ? "blocked_remote" : "awaiting_human_remote_handoff", reason: remote.enabled ? "Remote publication is disabled by autonomy policy." : "Remote publication is disabled in config.", candidate: { branch: manifest.branch, sha: manifest.candidateSha } };
    const candidate = { branch: manifest.branch, sha: manifest.candidateSha, base: this.config.baseRef };
    if (!candidate.branch || !/^[0-9a-f]{40}$/i.test(candidate.sha ?? "")) return { terminalState: "conflict_blocked", status: "conflict_blocked", reason: "Integration manifest does not contain an exact candidate branch and SHA." };
    const checkpoint = (stage, extra = {}) => {
      if (run.candidate && (run.candidate.branch !== candidate.branch || run.candidate.sha.toLowerCase() !== candidate.sha.toLowerCase())) throw new Error("Persisted delivery candidate identity does not match the integration manifest.");
      this.store.updateDeliveryRun(run.id, { state: "running", integrationPath: integration.path ?? run.integrationPath, candidate, publicationCheckpoint: { stage, candidate, updatedAt: new Date().toISOString(), ...extra } });
    };
    const failure = (error, stage, extra = {}) => {

      const code = error instanceof RemoteAdapterError ? error.code : "remote_failed";
      const terminalState = code === "credentials" ? "blocked_credentials" : code === "branch_protection" ? "blocked_branch_protection" : stage === "ci" ? "blocked_ci" : "failed";
      return { terminalState, status: terminalState, stage, reason: String(error.message ?? error).slice(0, 500), candidate, recovery: { action: "Inspect the persisted remote action and resolve the stated remote condition; rerun the launcher to resume idempotently." }, ...extra };
    };
    const runAction = async ({ key, kind, stage, action }) => {
      let stored = this.store.externalAction(key);
      if (stored?.status === "passed") return stored.payload;
      if (!stored) this.store.recordExternalAction({ idempotencyKey: key, kind, status: "started", payload: { candidate } });
      else this.store.updateExternalAction(key, { status: "started", payload: { ...stored.payload, candidate, retrying: true } });
      checkpoint(stage, { externalAction: key, status: "started" });
      try {
        const payload = await action();
        this.store.updateExternalAction(key, { status: payload?.status === "failed" || payload?.status === "timed_out" ? "failed" : "passed", payload });
        checkpoint(stage, { externalAction: key, status: "passed" });
        return payload;
      } catch (error) {
        this.store.updateExternalAction(key, { status: "failed", payload: { reason: String(error.message ?? error).slice(0, 500), code: error.code ?? null } });
        throw error;
      }
    };
    try {
      const pushKey = `push:${remote.remoteName}:${candidate.branch}:${candidate.sha}`;
      checkpoint("publication-ready");
      const remotePush = await runAction({ key: pushKey, kind: "remote-push", stage: "push", action: () => (remoteGitAdapter ?? new RemoteGitAdapter({ repository: this.config.repository, remoteName: remote.remoteName, allowedRemotes: remote.allowedRemotes, branchPrefix: remote.candidateBranchPrefix })).pushCandidate({ branch: candidate.branch, sha: candidate.sha, confirmRemotePush: auto || confirmRemotePush, idempotencyKey: pushKey }) });
      if ((remotePush?.verifiedSha ?? remotePush?.sha)?.toLowerCase() !== candidate.sha.toLowerCase()) throw new RemoteAdapterError("remote_sha_mismatch", "Candidate push did not verify the exact candidate SHA.");
      if (!autonomy.autoCreatePullRequest && !confirmRemotePush) return { terminalState: "awaiting_human", status: "awaiting_human_remote_handoff", candidate, remotePush, reason: "Candidate is pushed; manual PR mode is active." };
      const prKey = `pr:${candidate.branch}:${candidate.base}:${candidate.sha}`;
      const pullRequest = await runAction({ key: prKey, kind: "pull-request", stage: "pull-request", action: async () => {
        const adapter = pullRequestAdapter ?? new GitHubPullRequestAdapter({ repository: this.config.repository });
        if (typeof adapter.ensurePullRequest === "function") return adapter.ensurePullRequest({ branch: candidate.branch, base: candidate.base, sha: candidate.sha, idempotencyKey: prKey });
        if (typeof adapter.handoff === "function") return adapter.handoff(candidate);
        throw new RemoteAdapterError("pr_create_failed", "Configured pull request adapter cannot create a pull request.");
      } });
      if (!pullRequest?.number || pullRequest.headSha?.toLowerCase() !== candidate.sha.toLowerCase()) throw new RemoteAdapterError("pr_create_failed", "Pull request adapter did not verify that the PR head is the candidate SHA.");
      const ciKey = `ci:${pullRequest.number}:${candidate.sha}`;
      const remoteCi = await runAction({ key: ciKey, kind: "remote-ci", stage: "ci", action: async () => {
        const adapter = remoteCiAdapter ?? new GitHubCiAdapter({ repository: this.config.repository, timeoutMs: remote.ciTimeoutMs, pollIntervalMs: remote.ciPollIntervalMs, requiredContexts: remote.requiredCiContexts });
        return typeof adapter.waitForChecks === "function" ? adapter.waitForChecks({ pullRequest, candidate }) : adapter.verify(candidate);
      } });
      if (remoteCi.status !== "passed") return { terminalState: "blocked_ci", status: "blocked_ci", candidate, remotePush, pullRequest, remoteCi: { ...remoteCi, candidateSha: candidate.sha }, reason: remoteCi.reason ?? "Final merge requires green remote CI for the exact candidate SHA." };
      if (!autonomy.autoMerge && !confirmRemotePush) return { terminalState: "completed_candidate_ready", status: "completed_candidate_ready", candidate, remotePush, pullRequest, remoteCi };
      const acceptance = acceptanceReportId ? this.store.productAcceptanceReport(acceptanceReportId) : null;
      if (!acceptance || !acceptance.passing || acceptance.report.deliveryRunId !== run.id || acceptance.report.integrationManifestId !== manifest.id || acceptance.report.candidateSha.toLowerCase() !== candidate.sha.toLowerCase()) return { terminalState: "awaiting_final_acceptance", status: "awaiting_final_acceptance", candidate, remotePush, pullRequest, remoteCi: { ...remoteCi, candidateSha: candidate.sha } };
      const mergeKey = `merge:${pullRequest.number}:${candidate.sha}`;
      const merge = await runAction({ key: mergeKey, kind: "pull-request-merge", stage: "merge", action: () => (mergeAdapter ?? new GitHubMergeAdapter({ repository: this.config.repository, mergeMethod: remote.mergeMethod })).merge({ pullRequest, candidate, base: candidate.base, idempotencyKey: mergeKey }) });
      if (merge.status !== "merged" || !merge.mainSha || merge.targetVerified !== true) throw new RemoteAdapterError("merge_verify_failed", "Merge adapter did not verify the target branch after merge.");
      return { terminalState: "merge_verified", status: "merge_verified", candidate, remotePush, pullRequest, remoteCi: { ...remoteCi, candidateSha: candidate.sha }, merge, acceptanceReportId };
    } catch (error) {
      return failure(error, error?.code?.startsWith("ci") ? "ci" : error?.code?.startsWith("pr") ? "pull-request" : error?.code?.startsWith("merge") || error?.code === "branch_protection" ? "merge" : "push");
    }
  }

  async runToIntegration({ alreadyIdle = false, deliveryRunId = this.activeDeliveryRunId } = {}) {
    const gates = this.store.listTasks().filter((task) => (!deliveryRunId || task.deliveryRunId === deliveryRunId) && ["awaiting_human", "awaiting_approval"].includes(task.status));
    if (gates.length) throw new Error(`Run-to-integration refuses to bypass human gates: ${gates.map((task) => task.id).join(", ")}`);
    if (!alreadyIdle) await this.runUntilIdle();
    const tasks = this.store.listTasks().filter((task) => !deliveryRunId || task.deliveryRunId === deliveryRunId);
    const unfinished = tasks.filter((task) => ENGINEERING_DOMAINS.has(task.role) && task.status !== "done");
    if (unfinished.length) throw new Error(`Run-to-integration stopped before completion: ${unfinished.map((task) => `${task.id}:${task.status}`).join(", ")}`);
    const writerIds = tasks.filter((task) => this.config.roles[task.role]?.sandbox === "workspace-write" && task.status === "done").map((task) => task.id);
    if (!writerIds.length) throw new Error("Run-to-integration found no finalized writer artifacts");
    const writers = tasks.filter((task) => this.config.roles[task.role]?.sandbox === "workspace-write" && task.status === "done");
    const missingReviews = writers.filter((writer) => !this.#writerReviewPassed(writer.id));
    if (missingReviews.length) throw new Error(`Run-to-integration requires a passed Security and QA report for every final artifact chain: ${missingReviews.map((task) => task.id).join(", ")}`);
    const result = await this.integrateFinalized(writerIds);
    return { writerArtifacts: writerIds.map((id) => this.store.workerArtifact(id)), integration: result, nextAction: result.manifest.status === "candidate_ready" ? "Autonomous remote publication will push the verified candidate, create a PR, wait for CI, and merge when green." : "Resolve the blocked integration and retry." };
  }

  startProject() {
    const inventory = join(this.config.repository, this.config.project.documentationDir, "inventory.json");
    if (!existsSync(inventory)) throw new Error(`Project documentation has not been imported: ${inventory}`);
    const existingBootstrap = this.store.listTasks().find((task) => task.role === "bootstrap" && !task.parentTaskId && !["done", "failed", "cancelled", "blocked_budget", "blocked_specification", "interrupted"].includes(task.status));
    if (existingBootstrap) return existingBootstrap;
    const activeTasks = this.store.listTasks().filter((task) => !["done", "failed", "cancelled", "blocked_budget", "blocked_specification", "interrupted"].includes(task.status));
    if (activeTasks.length) throw new Error("This instance already has active orchestration tasks; recover or wait for the active delivery before starting another run");
    return this.enqueue({
      role: "bootstrap",
      title: `Bootstrap ${this.config.project.name}`,
      prompt: `Read ${this.config.project.documentationDir}/inventory.json and the Markdown files it lists. Produce the required structured blueprint for project '${this.config.project.name}'.`,
    });
  }

  approveHumanGate(taskId) {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (task.status === "awaiting_approval") {
      this.store.transition(task.id, "queued", { humanApproved: true, error: "Human resumed task after denied App Server approval request" });
      return { task: this.store.getTask(task.id), next: null, shouldRun: true, resumedApproval: true };
    }
    if (task.status !== "awaiting_human") throw new Error(`Task ${taskId} is not awaiting human approval`);
    if (task.role === "planner") {
      const readiness = this.executionReadiness();
      const override = this.store.budgetOverride(task.id);
      if (readiness.localP90ProjectedTokens > readiness.localBudget.weeklyTokenLimit && !override) throw new Error(`P90 local forecast ${readiness.localP90ProjectedTokens} exceeds local policy ${readiness.localBudget.weeklyTokenLimit}; record a separate budget override with a reason before approving`);
      this.store.transition(task.id, "done");
      return { task: this.store.getTask(task.id), next: null, readiness, override, shouldRun: true };
    }
    if (task.role !== "bootstrap") {
      this.store.transition(task.id, "queued", { humanApproved: true });
      return { task: this.store.getTask(task.id), next: null, budget: this.budgetSummary(), forecast: this.implementationForecast(), account: this.accountSummary(), shouldRun: true };
    }
    this.store.transition(task.id, "done");
    const planner = this.#enqueuePlanner(task);
    return { task: this.store.getTask(task.id), next: planner, shouldRun: true };
  }

  overrideBudgetGate(taskId, reason) {
    const task = this.store.getTask(taskId);
    if (!task || task.role !== "planner" || task.status !== "awaiting_human") throw new Error("Budget override is allowed only for a Planner task awaiting human approval");
    if (typeof reason !== "string" || reason.trim().length < 8) throw new Error("Budget override requires a specific human reason of at least 8 characters");
    const readiness = this.executionReadiness();
    if (readiness.localP90ProjectedTokens <= readiness.localBudget.weeklyTokenLimit) throw new Error("P90 local forecast does not exceed the configured local policy limit; no override is needed");
    this.store.recordBudgetOverride({ taskId, reason: reason.trim(), forecast: readiness });
    return { task, override: this.store.budgetOverride(taskId), readiness };
  }

  async runUntilIdle({ deliveryRunId = this.activeDeliveryRunId } = {}) {
    // Ownership is the first operation: a second controller must fail before
    // repository preflight, App Server launch, thread creation, or turn start.
    const sessionId = deliveryRunId && this.activeDeliveryRunId === deliveryRunId && this.activeDeliverySessionId ? this.activeDeliverySessionId : (deliveryRunId ? randomUUID() : null);
    if (deliveryRunId) this.store.claimDeliveryLease(deliveryRunId, { ownerPid: process.pid, ownerSessionId: sessionId });
    this.activeDeliveryRunId = deliveryRunId ?? null;
    this.activeDeliverySessionId = sessionId;
    await this.worktrees.verifyRepository();
    this.#validateWorkerOverlays();
    const client = this.config.appServerClientFactory?.({ cwd: this.config.repository }) ?? new AppServerClient({ cwd: this.config.repository });
    this.activeClient = client;
    this.stopRequested = false;
    this.expectedClientShutdown = false;
    this.budgetInterruptedTasks.clear();
    this.pendingBudgetWatchdogs.clear();
    this.activeTurns.clear();
    client.on("notification", (message) => this.#onNotification(message));
    client.on("serverRequest", (message) => this.#onServerRequest(client, message));
    client.on("protocol", (event) => this.#onProtocolEvent(event));
    client.on("fatal", (error) => {
      if (error.message !== "App Server client closed") this.#lifecycle("app-server error", { error: "App Server client failure" });
    });
    client.on("exit", ({ code, signal }) => {
      this.#lifecycle("app-server exited", { code, signal });
      if (!this.stopRequested && !this.expectedClientShutdown && this.activeDeliveryRunId) this.#markInterrupted("interrupted_controller_exit: App Server process exited", { code, signal });
    });
    const onSigint = () => { this.requestShutdown("interrupted_controller_exit: SIGINT received").catch(() => {}); };
    process.once("SIGINT", onSigint);
    const heartbeat = deliveryRunId ? setInterval(() => this.store.heartbeatDeliveryLease(deliveryRunId, this.activeDeliverySessionId), this.config.delivery?.leaseHeartbeatMs ?? 5_000) : null;
    try {
      await client.connect();
      this.#lifecycle("app-server connected");
      const snapshot = await this.account.refresh(client);
      this.#lifecycle(snapshot.diagnostics?.length ? "account read failed" : "account read completed", { diagnostics: snapshot.diagnostics?.length ?? 0 });
      const scheduler = { active: 0, blockedQuota: false, blockedBudget: false, failed: false };
      const workers = Array.from({ length: this.config.router.maxConcurrentTasks }, () => this.#worker(client, scheduler));
      await Promise.all(workers);
      // Notification handlers are intentionally non-blocking, but a terminal
      // scheduler result must not race a just-started budget interrupt.
      await Promise.allSettled([...this.pendingBudgetWatchdogs]);
      return { blockedQuota: scheduler.blockedQuota, blockedBudget: scheduler.blockedBudget || this.budgetInterruptedTasks.size > 0, failed: scheduler.failed, interrupted: this.stopRequested, quota: this.quotaThrottleStatus() };
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      process.removeListener("SIGINT", onSigint);
      this.lastAppServerDiagnostics = client.diagnostics();
      this.expectedClientShutdown = true;

      await client.shutdown();
      this.lastAppServerDiagnostics = client.diagnostics();
      if (this.activeClient === client) this.activeClient = null;
      this.activeTurns.clear();
      this.activeDeliverySessionId = null;
    }
  }

  async #worker(client, scheduler) {
    while (true) {
      if (this.stopRequested || scheduler.failed || this.budgetInterruptedTasks.size) { scheduler.blockedBudget ||= this.budgetInterruptedTasks.size > 0; return; }
      if (this.quotaThrottleStatus().throttled) { scheduler.blockedQuota = true; return; }
      const barriersRan = await this.#runReadyIntegrationBarriers(); const task = this.store.claimNext();
      if (!task) {
        if (barriersRan) continue;
        if (!scheduler.active) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
        continue;
      }
      scheduler.active += 1;
      try { await this.#runTask(client, task); }
      catch (error) {
        const current = this.store.getTask(task.id);
        if (current && !["awaiting_approval", "cancelled", "blocked_budget", "interrupted"].includes(current.status)) {
          let recovery = null;
          if (current.worktree) {
            try { recovery = await this.worktrees.recovery(current.worktree); }
            catch { recovery = null; }
          }
          const detail = recovery ? `${error.message} Recovery worktree: ${recovery.worktree} (${recovery.clean ? "clean" : "dirty"}). ${recovery.action}` : error.message;
          if (/specification_gap/i.test(detail)) { this.store.transition(task.id, "blocked_specification", { error: detail }); if (task.deliveryRunId) this.store.updateDeliveryRun(task.deliveryRunId, { state: "blocked_specification", publish: { reason: detail } }); }
          else { this.store.transition(task.id, "failed", { error: detail }); this.#recordScopedFailure(task, detail); }
        }
      } finally { this.#forgetTaskTurn(task.id); scheduler.active -= 1; }
    }
  }

  async #runTask(client, task) {
    const roleConfig = this.config.roles[task.role];
    const localBudget = this.#localBudgetDecision(task);
    if (this.#enforcesLocalBudget() && !localBudget.allowed) {
      this.store.transition(task.id, "blocked_budget", { error: `Local scheduler hard cap blocks this task: projected ${localBudget.projected} exceeds ${localBudget.limit}` });
      this.#lifecycle("budget preflight blocked", { taskId: task.id, scope: localBudget.scope, projected: localBudget.projected, limit: localBudget.limit, reservation: task.tokenBudget });
      return;
    }
    let overlayContext = ENGINEERING_DOMAINS.has(task.role) ? this.#workerOverlayContext() : null;
    const rootId = this.#rootId(task);
    const usage = this.store.usageForRoot(rootId);
    const decision = this.governor.canStart({ task, alreadyUsed: usage.used, alreadyReserved: Math.max(0, usage.reserved - task.tokenBudget), parentBudget: this.config.router.defaultParentBudget });
    if (this.#enforcesLocalBudget() && !decision.allowed) {
      this.store.transition(task.id, "blocked_budget", { error: `Projected ${decision.projected} exceeds budget ${decision.budget}` });
      return;
    }
    const runtimeBudget = this.#runtimeBudgetFor(task, localBudget);
    if (this.#enforcesLocalBudget() && runtimeBudget.interruptThresholdTokens < 1) {
      this.store.transition(task.id, "blocked_budget", { error: "Local scheduler hard cap leaves no runtime token budget for this task" });
      return;
    }

    let worktree = task.worktree;
    let branch = task.branch;
    if (roleConfig.sandbox === "workspace-write") this._assertWriterArtifactLineage(task);
    if (task.artifactBaseSha && roleConfig.sandbox === "workspace-write") {
      ({ worktree, branch } = await this.worktrees.create(task.id, { baseSha: task.artifactBaseSha }));
    } else if (task.sourceWriterTaskId) {
      const writer = this.store.getTask(task.sourceWriterTaskId);
      if (!writer?.worktree || !writer?.branch) throw new Error(`Review task ${task.id} has no finalized writer worktree`);
      ({ worktree, branch } = writer);
    } else if (roleConfig.usesWorktree) {
      const inherited = this.#inheritedWorktree(task);
      if (inherited) ({ worktree, branch } = inherited);
      else ({ worktree, branch } = await this.worktrees.create(task.id));
    }
    this.store.transition(task.id, "running", { worktree, branch });
    this.store.setRuntimeBudget(task.id, runtimeBudget);

    if (this.#isScaffoldTask(task)) {
      await this.#runDeterministicScaffold(task, { worktree, branch, overlayContext });
      return;
    }

    const sourceDir = fileURLToPath(new URL(".", import.meta.url));
    const developerInstructions = this.#developerInstructions(sourceDir, task.role);
    const threadResult = await client.startThread({
      model: this.config.model,
      cwd: worktree ?? this.config.repository,
      sandbox: roleConfig.sandbox,
      approvalPolicy: roleConfig.approvalPolicy,
      developerInstructions,
      serviceName: "codex-swarm-router"
    });
    const threadId = threadResult.thread.id;
    this.threadTasks.set(threadId, task.id);
    this.#lifecycle("thread started", { taskId: task.id, threadId });
    const goal = { threadId, objective: `${task.title}\n\n${task.prompt}`, status: "active" };
    // Delivery workers in tracking-only mode must not receive a token cap: it
    // turns the forecast into an agent-visible execution limit. Bootstrap and
    // Planner are deliberately bounded planning conversations, not product
    // workers; their soft goal budget keeps a malformed planning turn from
    // consuming the full delivery allowance before any code is written.
    if (this.#enforcesLocalBudget() || ["bootstrap", "planner"].includes(task.role)) goal.tokenBudget = task.tokenBudget;
    await client.setGoal(goal);
    const turnOptions = { threadId, input: [{ type: "text", text: this.#taskPrompt(task, worktree, overlayContext?.snapshot) }] };
    // The generated App Server schema explicitly allows `effort`; it does not
    // expose any server-side max-token field for turn/start.
    if (["bootstrap", "planner"].includes(task.role)) turnOptions.effort = "low";
    const turnResult = await client.startTurn(turnOptions);
    const turnId = turnResult.turn.id;
    this.store.setThread(task.id, { threadId, turnId });
    const completion = client.waitForTurn(threadId, turnId, this.config.router.turnTimeoutMs);
    this.activeTurns.set(task.id, { taskId: task.id, threadId, turnId, completion });
    this.#lifecycle("turn started", { taskId: task.id, threadId, turnId });
    const watched = { turn: await completion };
    const turn = watched.turn;
    const resolvedTurnId = turn.id ?? turnId;
    this.#adoptResolvedTurnId(task.id, threadId, resolvedTurnId);
    this.activeTurns.delete(task.id);
    const current = this.store.getTask(task.id);
    if (this.budgetInterruptedTasks.has(task.id) && current.status === "running") this.store.transition(task.id, "blocked_budget", { error: "budget_interrupt confirmed before result processing" });
    if (["awaiting_approval", "blocked_budget", "interrupted"].includes(this.store.getTask(task.id).status)) return;
    if (turn.status === "completed") {
      let resultText = watched.resultText ?? await this.#readAgentResult(client, threadId, resolvedTurnId);
      if (watched.overlayContext) overlayContext = watched.overlayContext;
      let resultPath;
      if (task.role === "bootstrap") {
        // Direct, non-project bootstrap tasks are retained for scheduler
        // diagnostics; Product intake always comes through startProject(),
        // which requires the source inventory below.
        if (!existsSync(join(this.config.repository, this.config.project.documentationDir, "inventory.json"))) {
          resultPath = this.#saveAgentResult(task, resultText);
          this.store.setResultPath(task.id, resultPath);
        } else {
        const blueprint = validateBootstrap(extractOrchestrationJson(resultText), { sourceDocuments: this.#importedSourceDocuments() });
        const persisted = this.#persistBlueprint(task, blueprint);
        this.store.setResultPath(task.id, persisted.artifactPath);
        if (task.deliveryRunId) this.store.linkBlueprintToDelivery(task.deliveryRunId, blueprint.blueprintId);
        const blockers = specificationBlockers(blueprint);
        if (blockers.length) {
          const reason = `blocked_specification: ${blockers.join(", ")}`;
          this.store.transition(task.id, "blocked_specification", { error: reason });
          if (task.deliveryRunId) this.store.updateDeliveryRun(task.deliveryRunId, { state: "blocked_specification", publish: { reason, recovery: { action: "Resolve the source-document contradiction or missing mandatory fact, then start a fresh delivery." } } });
          this.#lifecycle("specification blocked", { taskId: task.id, blueprintId: blueprint.blueprintId, blockers });
          return;
        }
        }
      }
      if (task.role === "planner") resultText = await this.#materializePlannerWithRepair(client, task, threadId, resultText);
      if (task.role === "security") {
        const report = validateSecurityGateReport(extractOrchestrationJson(resultText));
        resultPath = this.#saveSecurityReport(task, report);
        this.store.setResultPath(task.id, resultPath);
        this.store.recordSecurityReport({ securityTaskId: task.id, writerTaskId: task.sourceWriterTaskId, reportPath: resultPath, report });
        await this.#handleSecurityGate(task, report);
        return;
      }
      if (task.role === "qa") {
        const report = validateQualityGateReport(extractOrchestrationJson(resultText));
        const artifact = this.store.workerArtifact(task.sourceWriterTaskId);
        const checks = await this.#runDeclaredVerification(worktree, overlayContext.overlay, artifact?.changedPaths ?? []);
        report.executedChecks = [...report.executedChecks, ...checks.passed];
        report.notRunChecks = [...report.notRunChecks, ...checks.notRun];

        if (checks.failed.length) {
          report.verdict = "blocked";
          report.summary = "Controller verification failed; autonomous remediation cannot safely continue without valid scoped findings.";
        }
        resultPath = this.#saveQualityReport(task, report);
        this.store.setResultPath(task.id, resultPath);
        this.store.recordQualityReport({ qaTaskId: task.id, writerTaskId: task.sourceWriterTaskId, reportPath: resultPath, report });
        await this.#handleQualityGate(task, report);
        return;
      }
      resultPath = this.#saveAgentResult(task, resultText);
      this.store.setResultPath(task.id, resultPath);
      if (roleConfig.sandbox === "workspace-write") {
        let finalizedArtifact;
        resultPath = this.#saveAgentResult(task, resultText);
        this.store.setResultPath(task.id, resultPath);
        ({ overlayContext, resultText, finalized: finalizedArtifact } = await this.#finalizeWriterWithRepair(client, task, threadId, worktree, branch, overlayContext, resultText));
        const finalized = finalizedArtifact;
        this.store.recordWorkerArtifact(task.id, finalized.path, finalized.artifact);
        this.#connectArtifactDependents(task, finalized.artifact);
      }
      this.store.transition(task.id, finalStatusForRole(task.role, { autonomous: this.isAutonomous() }));
      if (task.role === "bootstrap" && this.isAutonomous() && this.store.productBlueprintForBootstrap(task.id)) this.#enqueuePlanner(task);
    }
    else if (turn.status === "interrupted") this.store.transition(task.id, "interrupted", { error: "Turn interrupted" });
    else this.store.transition(task.id, "failed", { error: turn.error?.message ?? "Turn failed" });
  }

  async #interruptAndAwaitTurn(client, { taskId, threadId, turnId }, reason, { timeoutMs = 3_000 } = {}) {
    if (!client || typeof threadId !== "string" || !threadId || typeof turnId !== "string" || !turnId) {
      this.#lifecycle("turn interrupt forced client shutdown", { taskId, threadId: threadId ?? null, turnId: turnId ?? null, reason: `${reason}: missing turn identity` });
      await client?.shutdown?.();
      return { terminal: null, forced: true };
    }
    this.#lifecycle("turn interrupt requested", { taskId, threadId, turnId, reason, tokenUsed: this.store.getTask(taskId)?.tokenUsed ?? null });
    try { await client.interruptTurn({ threadId, turnId }); }
    catch (error) { this.#lifecycle("turn interrupt request failed", { taskId, threadId, turnId, reason, error: String(error.message).slice(0, 300) }); }
    let terminal = null;
    try {
      const active = taskId ? this.activeTurns.get(taskId) : null;
      terminal = await Promise.race([
        active?.completion ?? client.waitForTurn(threadId, turnId, timeoutMs),
        new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs))
      ]);
    } catch { terminal = null; }
    if (terminal && ["completed", "failed", "interrupted", "cancelled"].includes(terminal.status)) {
      this.#lifecycle("turn interrupt terminal confirmed", { taskId, threadId, turnId: terminal.id ?? turnId, reason, terminalStatus: terminal.status, tokenUsed: this.store.getTask(taskId)?.tokenUsed ?? null });
      return { terminal, forced: false };
    }
    this.#lifecycle("turn interrupt forced client shutdown", { taskId, threadId, turnId, reason, tokenUsed: this.store.getTask(taskId)?.tokenUsed ?? null });
    const task = this.store.getTask(taskId);
    if (task?.status === "running") this.store.transition(taskId, "interrupted", { error: `${reason}: terminal confirmation timed out` });
    await client.shutdown();
    return { terminal: null, forced: true };
  }

  #forgetTaskTurn(taskId) {
    this.activeTurns.delete(taskId);
    for (const [threadId, mappedTaskId] of this.threadTasks.entries()) if (mappedTaskId === taskId) this.threadTasks.delete(threadId);
  }

  async #runDeterministicScaffold(task, { worktree, branch, overlayContext }) {
    if (!worktree || !branch) throw new Error("Deterministic scaffold requires an isolated workspace-write worktree");
    this.#lifecycle("deterministic scaffold started", { taskId: task.id, worktree });
    const provision = provisionDeterministicScaffold({ worktree, productRoots: this.config.project.productRoots });
    const refreshed = await this.#refreshProjectOverlayFromWorktree(worktree);
    const incomplete = (refreshed.overlay.components ?? []).filter((component) => component.state !== "scaffolded").map((component) => component.root);
    if (incomplete.length) throw new Error(`Deterministic scaffold did not produce declared component roots: ${incomplete.join(", ")}`);
    const resultText = `Controller-owned deterministic scaffold completed for ${provision.provisioned.map((item) => `${item.id}:${item.root}`).join(", ")}. No App Server turn was started.`;
    const resultPath = this.#saveAgentResult(task, resultText);
    this.store.setResultPath(task.id, resultPath);
    const finalized = await this.finalizer.finalize({ task, worktree, branch, overlay: refreshed.overlay, overlayPath: refreshed.path });
    this.store.recordWorkerArtifact(task.id, finalized.path, finalized.artifact);
    this.#connectArtifactDependents(task, finalized.artifact);
    this.store.transition(task.id, finalStatusForRole(task.role, { autonomous: this.isAutonomous() }));
    this.#lifecycle("deterministic scaffold completed", { taskId: task.id, artifactPath: finalized.path, components: provision.provisioned.map((item) => item.root) });
  }

  #taskPrompt(task, worktree, overlaySnapshot) {
    return [
      formatTaskPrompt({ task, worktree, project: this.config.project, overlaySnapshot, documentationAvailable: existsSync(join(this.config.repository, this.config.project.documentationDir, "inventory.json")) }),
      this.#structuredOutputContract(task.role),
      "Bounded execution: do only the required scoped work, do not create child agents, avoid long explanations, and return the required structured result. Do not merge, push, modify Router configuration, or bypass approval/sandbox policy."
    ].join("\n");
  }

  #workerOverlayContext() {
    const { overlay, path } = loadProjectOverlay(this.config.repository, this.config.project.generatedDir);
    return { overlay, path, snapshot: projectOverlayExecutionSnapshot(overlay) };
  }

  #validateWorkerOverlays() {
    for (const task of this.store.listTasks()) {
      if (ENGINEERING_DOMAINS.has(task.role) && ["queued", "preparing", "running"].includes(task.status)) this.#workerOverlayContext();
    }
  }

  async #runDeclaredVerification(worktree, overlay, changedPaths = []) {
    const passed = []; const failed = []; const notRun = [];
    const plan = commandsForPaths(overlay, changedPaths);
    for (const missing of plan.missing) failed.push({ id: `${missing.component}:declared-verification`, source: "controller", status: "failed", error: missing.reason });
    for (const command of plan.commands) {
      try {
        const result = await runManagedProcess({ executable: command.executable, args: command.args, cwd: commandCwd(worktree, command), timeoutMs: command.timeoutMs ?? 120_000 });
        passed.push({ id: command.id, source: "controller", status: "passed", pid: result.pid, stdout: result.stdout.slice(-4000), stderr: result.stderr.slice(-4000) });
      } catch (error) {
        failed.push({ id: command.id, source: "controller", status: "failed", error: String(error.message).slice(0, 500), pid: error.pid ?? null, stdout: String(error.stdout ?? "").slice(-4000), stderr: String(error.stderr ?? "").slice(-4000), timedOut: Boolean(error.timedOut) });
      }
    }
    if (!plan.commands.length && !plan.missing.length) notRun.push({ id: "declared-verification", reason: "No changed scaffolded product component requires verification" });
    return { passed, failed, notRun };
  }

  #enqueuePlanner(bootstrapTask) {
    const existing = this.store.listTasks().find((task) => task.role === "planner" && task.parentTaskId === bootstrapTask.id);
    if (existing) return existing;
    const stored = this.store.productBlueprintForBootstrap(bootstrapTask.id);
    if (!stored) throw new Error(`Bootstrap task ${bootstrapTask.id} has no persisted ProductBlueprint`);
    return this.enqueue({
      role: "planner",
      parentTaskId: bootstrapTask.id,
      title: `Plan ${this.config.project.name}`,
      prompt: `Use the immutable ProductBlueprint '${stored.blueprint.blueprintId}' at ${stored.artifactPath}. Produce the required JSON execution DAG with blueprintId '${stored.blueprint.blueprintId}' and non-empty requirementIds on every implementation task. For this greenfield multi-stack contract, include a devops writer task with id scaffold-product that creates every declared product root before any task writing under frontend/ or backend/.`,
      dependencies: [bootstrapTask.id], estimatedTokens: this.config.roles.planner.tokenBudget,
      blueprintId: stored.blueprint.blueprintId,
    });
  }

  isAutonomous() { return this.config.autonomy?.mode !== "manual"; }

  #localBudgetDecision(task) {
    const since = new Date(Date.now() - this.config.budget.weeklyWindowDays * 86_400_000).toISOString();
    const usage = this.store.weeklyUsageSince(since);
    const reservedWithoutCurrent = Math.max(0, usage.reserved - task.tokenBudget);
    const weeklyProjected = usage.used + reservedWithoutCurrent + task.tokenBudget;
    if (weeklyProjected > this.config.budget.weeklyTokenLimit) return { allowed: false, scope: "weekly", projected: weeklyProjected, limit: this.config.budget.weeklyTokenLimit, used: usage.used, reservedWithoutCurrent };
    const hardRunTokenLimit = this.config.budget.hardRunTokenLimit ?? this.config.budget.weeklyTokenLimit;
    const runUsage = task.deliveryRunId ? this.store.usageForDeliveryRun(task.deliveryRunId) : { used: 0, reserved: 0 };
    const runReservedWithoutCurrent = Math.max(0, runUsage.reserved - task.tokenBudget);
    const runProjected = runUsage.used + runReservedWithoutCurrent + task.tokenBudget;
    if (runProjected > hardRunTokenLimit) return { allowed: false, scope: "run", projected: runProjected, limit: hardRunTokenLimit, used: runUsage.used, reservedWithoutCurrent: runReservedWithoutCurrent };
    return { allowed: true, scope: "run", projected: runProjected, limit: hardRunTokenLimit, used: runUsage.used, reservedWithoutCurrent: runReservedWithoutCurrent, weeklyUsed: usage.used, weeklyProjected };
  }

  async #materializePlannerWithRepair(client, task, threadId, initialResultText) {
    let resultText = initialResultText;
    const maxRepairTurns = 2;
    for (let attempt = 0; attempt <= maxRepairTurns; attempt += 1) {
      try {
        const parsed = extractOrchestrationJson(resultText); if (parsed?.outcome === "specification_gap") throw new Error(`specification_gap: ${parsed.reason ?? "planner identified a required missing specification"}`); this.#materializePlan(task, parsed);
        return resultText;
      } catch (error) {
        if (attempt === maxRepairTurns) throw error;
        const reason = String(error.message).slice(0, 1000);
        this.#lifecycle("planner validation retry", { taskId: task.id, threadId, attempt: attempt + 1, reason });
        const retry = await client.startTurn({
          threadId,
          effort: "low",
          input: [{ type: "text", text: `Your previous execution DAG was rejected by the deterministic controller: ${reason}\nReturn a corrected replacement JSON only. Preserve the requested project scope. The controller will normalize declared frontend/backend scaffold paths and direct scaffold dependencies; do not invent risk-flag names.` }]
        });

        const requestedTurnId = retry.turn.id;
        this.store.setThread(task.id, { threadId, turnId: requestedTurnId });
        const completion = client.waitForTurn(threadId, requestedTurnId, this.config.router.turnTimeoutMs);
        this.activeTurns.set(task.id, { taskId: task.id, threadId, turnId: requestedTurnId, completion });
        this.#lifecycle("planner repair turn started", { taskId: task.id, threadId, turnId: requestedTurnId, attempt: attempt + 1 });
        const turn = await completion;
        const resolvedTurnId = turn.id ?? requestedTurnId;
        this.#adoptResolvedTurnId(task.id, threadId, resolvedTurnId);
        this.activeTurns.delete(task.id);
        if (turn.status !== "completed") throw new Error(`Planner corrective turn did not complete: ${turn.error?.message ?? turn.status}`);
        resultText = await this.#readAgentResult(client, threadId, resolvedTurnId);
      }
    }
    throw new Error("Planner validation retry loop terminated unexpectedly");
  }

  buildProductAcceptanceReport({ integration, remoteCi, productEvidence = null }) {
    const manifest = integration?.manifest; const run = this.activeDeliveryRunId ? this.store.deliveryRun(this.activeDeliveryRunId) : null; const stored = run?.blueprintId ? this.store.productBlueprint(run.blueprintId) : null;
    if (!run || !stored || !manifest || !integration.path || run.candidate?.sha?.toLowerCase() !== manifest.candidateSha?.toLowerCase()) throw new Error("Final acceptance requires persisted run identity");
    const applied = new Set(manifest.appliedArtifacts ?? []); const tasks = this.list().filter((task) => task.deliveryRunId === run.id);
    const evidence = (kind, status, reference) => ({ kind, status, reference, candidateSha: manifest.candidateSha });
    const product = productEvidence?.status === "pass" && productEvidence.candidateSha?.toLowerCase() === manifest.candidateSha.toLowerCase() ? evidence("product-e2e", "pass", productEvidence.reference ?? "product-e2e-adapter") : evidence("product-e2e", "not_verified", productEvidence?.reference ?? "product-e2e-unavailable");
    const resultStatus = (requirementId) => {
      const writers = tasks.filter((task) => task.requirementIds.includes(requirementId) && ENGINEERING_DOMAINS.has(task.role) && !["qa", "security"].includes(task.role)); const writerIds = new Set(writers.map((task) => task.id));
      const artifacts = writers.map((task) => this.store.workerArtifact(task.id)).filter(Boolean); const linked = artifacts.length && artifacts.every((artifact) => applied.has(artifact.taskId));
      const qa = tasks.filter((task) => task.role === "qa" && task.requirementIds.includes(requirementId)).map((task) => this.store.qualityReport(task.id)).filter(Boolean); const security = tasks.filter((task) => task.role === "security" && task.requirementIds.includes(requirementId)).map((task) => this.store.securityReport(task.id)).filter(Boolean);
      return linked && qa.length && security.length && qa.every((item) => writerIds.has(item.writerTaskId) && item.report.verdict === "pass") && security.every((item) => writerIds.has(item.writerTaskId) && item.report.verdict === "pass") ? "pass" : linked ? "partial" : "missing";
    };
    const report = { schemaVersion: PRODUCT_ACCEPTANCE_SCHEMA_VERSION, kind: PRODUCT_ACCEPTANCE_KIND, deliveryRunId: run.id, blueprintId: stored.blueprint.blueprintId, blueprintDigest: stored.digest, documentSetDigest: stored.documentSetDigest, integrationManifestPath: integration.path, integrationManifestId: manifest.id, candidateSha: manifest.candidateSha, generatedAt: new Date().toISOString(), evidence: { integration: evidence("integration-manifest", manifest.localVerification?.status === "passed" ? "pass" : "missing", integration.path), qa: evidence("qa-lineage", "pass", "quality_reports"), security: evidence("security-lineage", "pass", "security_reports"), productE2e: product, ci: evidence("remote-ci", remoteCi?.status === "passed" && remoteCi.candidateSha?.toLowerCase() === manifest.candidateSha.toLowerCase() ? "pass" : "not_verified", "remote-ci") }, results: [] };
    for (const requirement of stored.blueprint.requirements) { const status = resultStatus(requirement.requirementId); const lineage = evidence("artifact-lineage", status, `requirement:${requirement.requirementId}`); report.results.push({ requirementId: requirement.requirementId, criterionId: null, status, evidence: [lineage] }); for (const criterion of requirement.acceptanceCriteria) report.results.push({ requirementId: requirement.requirementId, criterionId: criterion.criterionId, status: product.status === "pass" ? status : product.status, evidence: [lineage, product] }); }
    return report;
  }

  async #finalizeWriterWithRepair(client, task, threadId, worktree, branch, initialOverlayContext, initialResultText) {
    let overlayContext = initialOverlayContext;
    let resultText = initialResultText;
    const maxRepairTurns = 2;
    for (let attempt = 0; attempt <= maxRepairTurns; attempt += 1) {
      try {
        const finalized = await this.finalizer.finalize({ task, worktree, branch, overlay: overlayContext.overlay, overlayPath: overlayContext.path });
        return { overlayContext, resultText, finalized };
      } catch (error) {
        if (attempt === maxRepairTurns) throw error;
        const reason = String(error.message).slice(0, 1600);
        this.#lifecycle("writer verification retry", { taskId: task.id, threadId, attempt: attempt + 1, reason });
        const retry = await client.startTurn({
          threadId,
          input: [{ type: "text", text: `The controller could not finalize your work because deterministic validation failed: ${reason}\nFix this failure now inside the existing worktree. Keep all edits within the assigned allowed paths. Run the required checks. Do not explain or plan; make the correction and finish.` }]
        });
        const requestedTurnId = retry.turn.id;
        this.store.setThread(task.id, { threadId, turnId: requestedTurnId });
        const completion = client.waitForTurn(threadId, requestedTurnId, this.config.router.turnTimeoutMs);
        this.activeTurns.set(task.id, { taskId: task.id, threadId, turnId: requestedTurnId, completion });
        this.#lifecycle("writer repair turn started", { taskId: task.id, threadId, turnId: requestedTurnId, attempt: attempt + 1 });
        const turn = await completion;
        const resolvedTurnId = turn.id ?? requestedTurnId;
        this.#adoptResolvedTurnId(task.id, threadId, resolvedTurnId);
        this.activeTurns.delete(task.id);
        if (turn.status !== "completed") throw new Error(`Writer corrective turn did not complete: ${turn.error?.message ?? turn.status}`);
        resultText = await this.#readAgentResult(client, threadId, resolvedTurnId);
      }
    }
    throw new Error("Writer verification retry loop terminated unexpectedly");
  }

  #enforcesLocalBudget() { return this.config.budget?.enforceLocalLimits === true; }

  #runtimeBudgetFor(task, localBudget) {
    if (!this.#enforcesLocalBudget()) return { interruptThresholdTokens: null, configuredBudgetCap: null };
    const safetyMargin = this.config.budget.interruptSafetyMarginTokens ?? 0;
    const configuredBudgetCap = task.tokenBudget;
    const configuredThreshold = this.config.roles[task.role].interruptThresholdTokens ?? Math.max(1, configuredBudgetCap - safetyMargin);
    const runRemaining = Math.max(0, localBudget.limit - localBudget.used - localBudget.reservedWithoutCurrent);
    return { interruptThresholdTokens: Math.min(configuredThreshold, runRemaining), configuredBudgetCap };
  }

  #writerReviewPassed(writerId) {
    const tasks = this.store.listTasks();
    const descendants = new Set([writerId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const task of tasks) {
        if (this.config.roles[task.role]?.sandbox !== "workspace-write" || descendants.has(task.id)) continue;
        if ((task.artifactDependencies ?? []).some((dependency) => descendants.has(dependency))) { descendants.add(task.id); changed = true; }
      }
    }
    return [...descendants].some((candidate) => {
      const security = tasks.find((task) => task.role === "security" && task.sourceWriterTaskId === candidate);
      const quality = tasks.find((task) => task.role === "qa" && task.sourceWriterTaskId === candidate);
      return security?.status === "done" && quality?.status === "done"
        && this.store.securityReport(security.id)?.report.verdict === "pass"
        && this.store.qualityReport(quality.id)?.report.verdict === "pass";
    });
  }

  #saveQualityReport(task, report) {
    const root = join(this.config.repository, this.config.project.generatedDir, "quality-reports");
    mkdirSync(root, { recursive: true });
    const path = join(root, `${task.id}.v${report.schemaVersion}.json`);
    writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return relative(this.config.repository, path).split("\\").join("/");
  }

  #saveSecurityReport(task, report) {
    const root = join(this.config.repository, this.config.project.generatedDir, "security-reports");
    mkdirSync(root, { recursive: true });
    const path = join(root, `${task.id}.v${report.schemaVersion}.json`);
    writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return relative(this.config.repository, path).split("\\").join("/");
  }

  async #handleQualityGate(task, report) {
    const writer = this.store.getTask(task.sourceWriterTaskId);
    if (!writer) throw new Error(`Quality task ${task.id} has no source writer`);
    const maxRounds = this.config.delivery?.maxRemediationRounds ?? 2;
    const nextRound = (writer.remediationRound ?? 0) + 1;
    if (report.verdict === "pass") {
      this.store.transition(task.id, "done");
      this.#lifecycle("quality gate passed", { taskId: task.id, writerTaskId: writer.id });
      return;
    }
    const terminal = report.verdict === "blocked" || (report.verdict === "remediation_required" && nextRound > maxRounds);
    if (terminal) {
      const reason = report.verdict === "blocked" ? "Quality gate blocked; verification or findings are not safely remediable." : `Quality remediation limit (${maxRounds}) exhausted.`;
      this.store.transition(task.id, this.isAutonomous() ? "failed" : "awaiting_human", { error: reason });
      this.#lifecycle(this.isAutonomous() ? "quality gate terminal" : "quality gate awaiting human", { taskId: task.id, writerTaskId: writer.id, verdict: report.verdict, reason });
      return;
    }
    if (!this.isAutonomous() || this.config.autonomy?.autoRemediate === false) {
      this.store.transition(task.id, "awaiting_human", { error: "Quality findings require manual remediation in manual mode." });
      return;
    }
    const predecessor = this.store.workerArtifactRecord(writer.id);
    if (!predecessor?.artifact) throw new Error(`Quality remediation requires finalized artifact for ${writer.id}`);
    const allowedPaths = remediationScope(report, writer);
    const remediation = this.enqueue({
      role: writer.role,
      parentTaskId: task.id,
      title: `Remediate ${writer.title} (round ${nextRound})`,
      prompt: `Apply only these validated QualityGate findings. Do not expand scope or risk: ${JSON.stringify(report.findings.map((finding) => ({ id: finding.id, path: finding.path, requiredFix: finding.requiredFix, verification: finding.verification })))}.`,
      allowedPaths,
      acceptanceChecks: report.findings.map((finding) => finding.verification),
      dependencies: [task.id],
      estimatedTokens: Math.min(this.config.roles[writer.role].tokenBudget, writer.estimatedTokens),
      riskFlags: writer.riskFlags,
      supportingDomains: ["security", "qa"],
      artifactBaseSha: predecessor.artifact.headSha,
      artifactDependencies: [writer.id],
      remediationRound: nextRound,
      sourceWriterTaskId: null,
      blueprintId: writer.blueprintId,
      requirementIds: writer.requirementIds,
      deliveryRunId: writer.deliveryRunId
    });
    const security = this.enqueue({
      role: "security", parentTaskId: remediation.id, title: `Security review: ${remediation.title}`,
      prompt: `Review the finalized remediation artifact for '${writer.title}'. Do not expand scope; report only concrete security findings.`,
      allowedPaths, acceptanceChecks: report.findings.map((finding) => finding.verification), dependencies: [remediation.id],
      estimatedTokens: Math.min(this.config.roles.security.tokenBudget, Math.max(1, Math.ceil(remediation.estimatedTokens * 0.35))),
      riskFlags: writer.riskFlags, supportingDomains: ["security"], sourceWriterTaskId: remediation.id, blueprintId: writer.blueprintId, requirementIds: writer.requirementIds, deliveryRunId: writer.deliveryRunId
    });
    this.enqueue({
      role: "qa", parentTaskId: security.id, title: `QA: ${remediation.title}`,
      prompt: `Verify the finalized remediation artifact for '${writer.title}'. Return the required QualityGateReport only.`,
      allowedPaths, acceptanceChecks: report.findings.map((finding) => finding.verification), dependencies: [security.id],
      estimatedTokens: Math.min(this.config.roles.qa.tokenBudget, Math.max(1, Math.ceil(remediation.estimatedTokens * 0.4))),
      riskFlags: writer.riskFlags, supportingDomains: ["qa"], sourceWriterTaskId: remediation.id, blueprintId: writer.blueprintId, requirementIds: writer.requirementIds, deliveryRunId: writer.deliveryRunId
    });
    this.store.transition(task.id, "done");
    this.#lifecycle("remediation queued", { taskId: remediation.id, writerTaskId: writer.id, remediationRound: nextRound });
  }

  async #handleSecurityGate(task, report) {
    const writer = this.store.getTask(task.sourceWriterTaskId);
    if (!writer) throw new Error(`Security task ${task.id} has no source writer`);
    const maxRounds = this.config.delivery?.maxRemediationRounds ?? 2;

    const nextRound = (writer.remediationRound ?? 0) + 1;
    if (report.verdict === "pass") {
      this.store.transition(task.id, "done");
      this.#lifecycle("security gate passed", { taskId: task.id, writerTaskId: writer.id });
      return;
    }
    const terminal = report.verdict === "blocked" || (report.verdict === "remediation_required" && nextRound > maxRounds);
    if (terminal) {
      const reason = report.verdict === "blocked" ? "Security gate blocked; findings are not safely remediable." : `Security remediation limit (${maxRounds}) exhausted.`;
      this.store.transition(task.id, this.isAutonomous() ? "failed" : "awaiting_human", { error: reason });
      this.#lifecycle(this.isAutonomous() ? "security gate terminal" : "security gate awaiting human", { taskId: task.id, writerTaskId: writer.id, verdict: report.verdict, reason });
      return;
    }
    if (!this.isAutonomous() || this.config.autonomy?.autoRemediate === false) {
      this.store.transition(task.id, "awaiting_human", { error: "Security findings require manual remediation in manual mode." });
      return;
    }
    const predecessor = this.store.workerArtifactRecord(writer.id);
    if (!predecessor?.artifact) throw new Error(`Security remediation requires finalized artifact for ${writer.id}`);
    const allowedPaths = remediationScope(report, writer);
    const remediation = this.enqueue({ role: writer.role, parentTaskId: task.id, title: `Remediate ${writer.title} (security round ${nextRound})`, prompt: `Apply only these validated SecurityGate findings. Do not expand scope or risk: ${JSON.stringify(report.findings.map((finding) => ({ id: finding.id, path: finding.path, requiredFix: finding.requiredFix, verification: finding.verification })))}.`, allowedPaths, acceptanceChecks: report.findings.map((finding) => finding.verification), dependencies: [task.id], estimatedTokens: Math.min(this.config.roles[writer.role].tokenBudget, writer.estimatedTokens), riskFlags: writer.riskFlags, supportingDomains: ["security", "qa"], artifactBaseSha: predecessor.artifact.headSha, artifactDependencies: [writer.id], remediationRound: nextRound, blueprintId: writer.blueprintId, requirementIds: writer.requirementIds, deliveryRunId: writer.deliveryRunId });
    const security = this.enqueue({ role: "security", parentTaskId: remediation.id, title: `Security review: ${remediation.title}`, prompt: `Review the finalized security remediation artifact for '${writer.title}'. Return the required SecurityGateReport only.`, allowedPaths, acceptanceChecks: remediation.acceptanceChecks, dependencies: [remediation.id], estimatedTokens: Math.min(this.config.roles.security.tokenBudget, Math.max(1, Math.ceil(remediation.estimatedTokens * 0.35))), riskFlags: writer.riskFlags, supportingDomains: ["security"], sourceWriterTaskId: remediation.id, blueprintId: writer.blueprintId, requirementIds: writer.requirementIds, deliveryRunId: writer.deliveryRunId });
    this.enqueue({ role: "qa", parentTaskId: security.id, title: `QA: ${remediation.title}`, prompt: `Verify the finalized security remediation artifact for '${writer.title}'. Return the required QualityGateReport only.`, allowedPaths, acceptanceChecks: remediation.acceptanceChecks, dependencies: [security.id], estimatedTokens: Math.min(this.config.roles.qa.tokenBudget, Math.max(1, Math.ceil(remediation.estimatedTokens * 0.4))), riskFlags: writer.riskFlags, supportingDomains: ["qa"], sourceWriterTaskId: remediation.id, blueprintId: writer.blueprintId, requirementIds: writer.requirementIds, deliveryRunId: writer.deliveryRunId });
    this.store.transition(task.id, "done");
    this.#lifecycle("security remediation queued", { taskId: remediation.id, writerTaskId: writer.id, remediationRound: nextRound });
  }

  #structuredOutputContract(role) {
    if (role === "bootstrap") return `Return only one fenced JSON ProductBlueprint v1. Required exact top-level fields: {"schemaVersion":1,"kind":"ProductBlueprint","blueprintId":"stable-kebab-id","createdAt":"ISO-8601","documentSetDigest":"sha256","sourceDocuments":[{"documentId":"doc-id","path":"path","sha256":"sha256"}],"requirements":[{"requirementId":"stable-kebab-id","type":"functional|nfr|data|integration|constraint","priority":"must|should|could","mandatory":true,"description":"string","sourceRefs":[{"documentId":"doc-id","locator":"line/heading locator","excerptDigest":"sha256"}],"acceptanceCriteria":[{"criterionId":"stable-kebab-id","description":"string","verificationHint":"optional"}],"constraints":[]}],"nfrs":[],"modules":[],"integrations":[],"dataModel":{},"constraints":[],"assumptions":[],"decisions":[{"adrId":"stable-kebab-id","decision":"string","rationale":"string","sourceRefs":[]}],"unresolvedQuestions":[{"questionId":"stable-kebab-id","description":"string","requiredForRequirementIds":["requirement-id"],"policyDefault":"only an explicitly declared source-policy default","status":"resolved_by_policy|unresolved"}],"contradictions":[{"contradictionId":"stable-kebab-id","requirementIds":["requirement-id"],"sourceRefs":[],"description":"string","status":"resolved|unresolved","resolution":"required when resolved"}]}. sourceDocuments must exactly match inventory.json. Do not invent resolutions: a missing mandatory fact or unresolved contradiction stays unresolved.`;
    if (role === "planner") return `Return only one fenced JSON PlanBatch with this schema:\n{"blueprintId":"persisted-blueprint-id","tasks":[{"id":"safe-kebab-id","title":"string","prompt":"specific implementation instruction","primaryDomain":"backend|frontend|database|qa|security|devops","supportingDomains":["qa","security"],"riskFlags":["public_api_change"],"humanApprovalRequired":false,"estimatedTokens":8000,"dependsOn":["other-task-id"],"allowedPaths":["path"],"acceptanceChecks":["test or check"],"requirementIds":["ProductBlueprint requirement id"]}]}. Every implementation task must have non-empty requirementIds from the immutable ProductBlueprint; every mandatory requirement must be covered. Return the JSON as your first and only deliverable: do not use web search, do not install packages, do not run tests, and do not explore source code beyond the imported Markdown inventory. allowedPaths must be explicit. Do not create implementation tasks for ambiguity or silently resolve contradictions.`;
    if (role === "qa") return `Return only one fenced JSON QualityGateReport: {"verdict":"pass|remediation_required|blocked","summary":"string","findings":[{"id":"stable-id","severity":"low|medium|high|critical","path":"relative/path","evidence":"concrete safe evidence","requiredFix":"specific fix","verification":"specific verification"}],"executedChecks":[],"notRunChecks":[]}. Never include secrets or raw command output. A pass requires no findings.`;
    if (role === "security") return `Return only one fenced JSON SecurityGateReport: {"verdict":"pass|remediation_required|blocked","summary":"string","findings":[{"id":"stable-id","severity":"low|medium|high|critical","path":"relative/path","evidence":"concrete safe evidence","requiredFix":"specific fix","verification":"specific verification"}],"executedChecks":[],"notRunChecks":[]}. Never include secrets or raw command output. A pass requires no findings.`;
    return "Return a concise Markdown report with evidence; do not return orchestration JSON.";
  }

  #developerInstructions(sourceDir, role) {
    const root = join(sourceDir, "..");
    const files = [join(root, "policies", "core.md"), join(root, "policies", `${role}.md`), join(root, "roles", `${role}.md`)];
    return files.filter((path) => existsSync(path)).map((path) => readFileSync(path, "utf8")).join("\n\n");
  }

  async #readAgentResult(client, threadId, turnId) {
    const response = await client.readThread({ threadId, includeTurns: true });
    return agentResultForTurn(response, turnId);
  }

  #saveAgentResult(task, resultText) {
    const generatedRoot = join(this.config.repository, this.config.project.generatedDir, "results");
    mkdirSync(generatedRoot, { recursive: true });
    const absolutePath = join(generatedRoot, `${task.id}.md`);
    writeFileSync(absolutePath, resultText, "utf8");
    return relative(this.config.repository, absolutePath).split("\\").join("/");
  }

  #importedSourceDocuments() {
    const inventory = JSON.parse(readFileSync(join(this.config.repository, this.config.project.documentationDir, "inventory.json"), "utf8"));
    if (!Array.isArray(inventory.files) || inventory.files.some((file) => !file.documentId || !file.sha256)) throw new Error("Documentation inventory is missing ProductBlueprint source hashes; re-import documentation before Bootstrap.");
    return inventory.files.map(({ documentId, path, sha256 }) => ({ documentId, path, sha256 }));
  }

  #persistBlueprint(task, blueprint) {
    const root = join(this.config.repository, this.config.project.generatedDir, "blueprints");
    mkdirSync(root, { recursive: true });
    const artifactPath = join(this.config.project.generatedDir, "blueprints", `${blueprint.blueprintId}.v1.json`).split("\\").join("/");
    const absolutePath = join(this.config.repository, artifactPath);
    const serialized = `${JSON.stringify(blueprint, null, 2)}\n`;
    const digest = createHash("sha256").update(serialized).digest("hex");
    if (existsSync(absolutePath)) throw new Error(`ProductBlueprint artifact already exists and is immutable: ${artifactPath}`);
    writeFileSync(absolutePath, serialized, { encoding: "utf8", flag: "wx" });
    return this.store.recordProductBlueprint({ blueprint, artifactPath, digest, bootstrapTaskId: task.id, deliveryRunId: task.deliveryRunId ?? null });
  }

  #materializePlan(plannerTask, parsedPlan) {
    const stored = this.store.productBlueprint(plannerTask.blueprintId);
    if (!stored) throw new Error(`Planner task ${plannerTask.id} has no persisted ProductBlueprint`);
    const planRunId = plannerTask.deliveryRunId ?? `standalone:${plannerTask.id}`, previous = this.store.currentCheckpoint(planRunId);
    const batchInput = parsedPlan?.kind === "PlanBatch" ? parsedPlan : { ...parsedPlan, schemaVersion: 1, kind: "PlanBatch", id: randomUUID(), deliveryRunId: planRunId, wave: previous ? previous.wave + 1 : 1, basedOnCheckpointSha: previous?.outputSha ?? gitSha(this.config.repository, this.config.baseRef), createdAt: new Date().toISOString() };
    const plan = validatePlan(normalizePlannerPlanForProject(batchInput, this.config.project.productRoots), { maxTasks: this.config.router.maxPlanTasks, productRoots: this.config.project.productRoots, blueprint: stored.blueprint, requirePlanBatch: true });
    if (plan.deliveryRunId !== planRunId) throw new Error("PlanBatch deliveryRunId must match Planner delivery run");
    const existingBatches = this.store.planBatches(plan.deliveryRunId); if (existingBatches.length) { const checkpoint = this.store.currentCheckpoint(plan.deliveryRunId); if (!checkpoint || plan.wave !== checkpoint.wave + 1 || plan.basedOnCheckpointSha !== checkpoint.outputSha) throw new Error("Next PlanBatch requires successful reconciliation of the current verified checkpoint"); } else if (plan.wave !== 1 || plan.basedOnCheckpointSha !== gitSha(this.config.repository, this.config.baseRef)) throw new Error("PlanBatch wave 1 must use the controller verified repository baseline");
    const orderedPlanIds = new Map();
    const pending = [...plan.tasks];
    const dispatch = [];
    while (pending.length) {
      const readyIndex = pending.findIndex((item) => item.dependsOn.every((dependency) => orderedPlanIds.has(dependency)));
      if (readyIndex === -1) throw new Error("Unable to topologically order the validated plan");
      const [item] = pending.splice(readyIndex, 1);
      const securityRequired = item.supportingDomains.includes("security") || item.riskFlags.some((flag) => ["auth_or_authorization", "secret_handling", "sensitive_data", "network_exposure", "permission_change", "dependency_supply_chain"].includes(flag));
      const elevatedGate = !this.isAutonomous() && (item.humanApprovalRequired || securityRequired || item.riskFlags.some((flag) => ["schema_change", "destructive_data_change", "irreversible_operation", "permission_change"].includes(flag)));
      if (!this.config.roles[item.primaryDomain]) throw new Error(`No role configuration for planned domain ${item.primaryDomain}`);
      dispatch.push({ item, securityRequired, elevatedGate, dependencyPlanIds: [...item.dependsOn] });
      orderedPlanIds.set(item.id, true);
    }
    const needsSupport = dispatch.some(({ item, securityRequired }) => this.config.roles[item.primaryDomain]?.sandbox === "workspace-write" || (securityRequired && item.primaryDomain !== "security") || (item.supportingDomains.includes("qa") && item.primaryDomain !== "qa"));
    const plannerDepth = depthOf(plannerTask, (id) => this.store.getTask(id));
    if (plannerDepth + 1 > this.config.router.maxDelegationDepth || (needsSupport && plannerDepth + 2 > this.config.router.maxDelegationDepth)) throw new Error("Validated plan exceeds delegation depth limit");
    if (this.store.childCount(plannerTask.id) + dispatch.length > this.config.router.maxChildrenPerTask) throw new Error("Validated plan exceeds child task limit");
    if (needsSupport && this.config.router.maxChildrenPerTask < 1) throw new Error("Validated plan requires support tasks but child task limit is zero");

    const assertRoute = (role, estimatedTokens) => {
      const roleConfig = this.config.roles[role];
      if (!roleConfig) throw new Error(`No role configuration for routed domain ${role}`);
      if (!Number.isInteger(estimatedTokens) || estimatedTokens < 1 || estimatedTokens > roleConfig.tokenBudget) throw new Error(`Invalid routed token estimate for ${role}`);
      return roleConfig;
    };
    const primaryIds = new Map(dispatch.map(({ item }) => [item.id, randomUUID()]));
    const scaffoldTaskId = primaryIds.get("scaffold-product") ?? null;
    const primaryRoleByTaskId = new Map(dispatch.map(({ item }) => [primaryIds.get(item.id), item.primaryDomain]));
    const specs = [];
    // Build and validate the whole dispatch graph before making one atomic
    // StateStore write. This prevents a rejected route from leaving a partial DAG.
    for (const { item, elevatedGate, securityRequired, dependencyPlanIds } of dispatch) {
      const primary = assertRoute(item.primaryDomain, item.estimatedTokens);
      const primaryId = primaryIds.get(item.id);
      const dependencies = [plannerTask.id, ...dependencyPlanIds.map((dependency) => primaryIds.get(dependency))];
      if (scaffoldTaskId && item.id !== "scaffold-product" && primary.sandbox === "workspace-write" && !dependencies.includes(scaffoldTaskId)) dependencies.push(scaffoldTaskId);
      const writerPredecessors = dependencies
        .filter((dependency) => dependency !== plannerTask.id)
        .filter((dependency) => this.config.roles[primaryRoleByTaskId.get(dependency)]?.sandbox === "workspace-write");
      const fanIn = writerPredecessors.length > 1;
      const prompt = item.id === "scaffold-product"
        ? "[[product-scaffold]]\nController-owned scaffold contract: create every declared product root now. frontend/ must be a runnable Next.js application with package.json, npm lockfile, build and test scripts. backend/ must be an ASP.NET Core Web API solution with an xUnit test project. Do not create placeholders, plans, or a partial root. Run the declared checks after files are written."
        : item.prompt;
      specs.push({ id: primaryId, role: item.primaryDomain, parentTaskId: plannerTask.id, title: item.title, prompt, allowedPaths: item.allowedPaths, acceptanceChecks: item.acceptanceChecks, dependencies, estimatedTokens: item.estimatedTokens, tokenBudget: primary.tokenBudget, maxAttempts: 1, humanApprovalRequired: elevatedGate, riskFlags: item.riskFlags, supportingDomains: item.supportingDomains, artifactBaseSha: primary.sandbox === "workspace-write" ? plan.basedOnCheckpointSha : null, artifactDependencies: fanIn ? [] : writerPredecessors, integrationBarrierId: fanIn ? `pending:${primaryId}` : null, blueprintId: stored.blueprint.blueprintId, requirementIds: item.requirementIds, deliveryRunId: planRunId, planBatchId: plan.id, wave: plan.wave });
      let predecessorId = primaryId;
      const mandatoryReview = primary.sandbox === "workspace-write";
      if ((mandatoryReview || securityRequired) && item.primaryDomain !== "security") {
        const estimate = Math.min(this.config.roles.security?.tokenBudget ?? 0, Math.max(1000, Math.ceil(item.estimatedTokens * 0.35)));
        const security = assertRoute("security", estimate);
        predecessorId = randomUUID();
        specs.push({ id: predecessorId, role: "security", parentTaskId: primaryId, title: `Security review: ${item.title}`, prompt: `Review finalized writer artifact '${item.title}' for declared risk flags: ${item.riskFlags.join(", ") || "none"}. Return the required SecurityGateReport only.`, allowedPaths: item.allowedPaths, acceptanceChecks: item.acceptanceChecks, dependencies: [primaryId], estimatedTokens: estimate, tokenBudget: security.tokenBudget, maxAttempts: 1, humanApprovalRequired: false, riskFlags: item.riskFlags, supportingDomains: ["security"], sourceWriterTaskId: primaryId, blueprintId: stored.blueprint.blueprintId, requirementIds: item.requirementIds, deliveryRunId: plannerTask.deliveryRunId ?? this.activeDeliveryRunId });
      }
      if ((mandatoryReview || item.supportingDomains.includes("qa")) && item.primaryDomain !== "qa") {
        const estimate = Math.min(this.config.roles.qa?.tokenBudget ?? 0, Math.max(1000, Math.ceil(item.estimatedTokens * 0.4)));
        const qa = assertRoute("qa", estimate);
        specs.push({ id: randomUUID(), role: "qa", parentTaskId: predecessorId, title: `QA: ${item.title}`, prompt: `Verify finalized writer artifact '${item.title}' against acceptance checks. Return the required QualityGateReport only.`, allowedPaths: item.allowedPaths, acceptanceChecks: item.acceptanceChecks, dependencies: [predecessorId], estimatedTokens: estimate, tokenBudget: qa.tokenBudget, maxAttempts: 1, humanApprovalRequired: false, riskFlags: item.riskFlags, supportingDomains: ["qa"], sourceWriterTaskId: primaryId, blueprintId: stored.blueprint.blueprintId, requirementIds: item.requirementIds, deliveryRunId: plannerTask.deliveryRunId ?? this.activeDeliveryRunId });
      }
    }
    this.store.createPlanBatch(plan, specs);
  }

  async #refreshProjectOverlayFromWorktree(worktree) {
    return generateProjectOverlay({ repository: this.config.repository, inspectionRoot: worktree, baseRef: this.config.baseRef, generatedDir: this.config.project.generatedDir, project: this.config.project });
  }

  #isScaffoldTask(task) { return task.prompt.startsWith("[[product-scaffold]]"); }

  async #failFastAfterTaskFailure(client, scheduler, failedTaskId, error) {
    if (scheduler.failed) return;
    scheduler.failed = true;
    const active = [...this.activeTurns.values()].filter((item) => item.taskId !== failedTaskId);
    this.#lifecycle("delivery fail-fast", { taskId: failedTaskId, error: String(error).slice(0, 300), interruptedTasks: active.map((item) => item.taskId) });
    await Promise.allSettled(active.map((turn) => this.#interruptAndAwaitTurn(client, turn, "delivery_fail_fast", { timeoutMs: this.config.delivery?.shutdownGraceMs ?? 3_000 })));
  }

  #connectArtifactDependents(predecessor, artifact) {
    for (const task of this.store.listTasks()) {
      if (task.id === predecessor.id || !task.dependencies.includes(predecessor.id) || this.config.roles[task.role]?.sandbox !== "workspace-write") continue;
      const writerPredecessors = task.dependencies.filter((dependency) => this.config.roles[this.store.getTask(dependency)?.role]?.sandbox === "workspace-write");
      if (writerPredecessors.length === 1 && !task.integrationBarrierId) this.store.setArtifactLineage(task.id, { artifactBaseSha: artifact.headSha, artifactDependencies: writerPredecessors });
    }

  }
  _assertWriterArtifactLineage(task) {
    const writerPredecessors = task.dependencies.filter((dependency) => this.config.roles[this.store.getTask(dependency)?.role]?.sandbox === "workspace-write");
    if (writerPredecessors.length > 1) { const barrier = this.store.integrationBarrier(task.integrationBarrierId), checkpoint = barrier?.checkpointId ? this.store.integrationCheckpoint(barrier.checkpointId) : null; if (!barrier || barrier.status !== "passed" || !checkpoint) throw new Error(`Writer task ${task.id} cannot start before its IntegrationBarrier checkpoint`); validateIntegrationCheckpoint(checkpoint); if (task.artifactBaseSha !== checkpoint.outputSha || (task.artifactDependencies ?? []).length) throw new Error(`Writer task ${task.id} must start exactly from IntegrationCheckpoint output SHA`); return; }
    if (!writerPredecessors.length) return;
    const predecessorId = writerPredecessors[0];
    const predecessor = this.store.workerArtifact(predecessorId);
    if (!predecessor) throw new Error(`Writer task ${task.id} cannot start before predecessor ${predecessorId} has a WorkerArtifact`);
    if (task.artifactBaseSha !== predecessor.headSha || task.artifactDependencies.length !== 1 || task.artifactDependencies[0] !== predecessorId) {
      throw new Error(`Writer task ${task.id} is missing artifact lineage from predecessor ${predecessorId}`);
    }
  }
  async #runReadyIntegrationBarriers() { let progressed=false; for (const task of this.store.listTasks()) { if(this.config.roles[task.role]?.sandbox!=="workspace-write"||!String(task.integrationBarrierId??"").startsWith("pending:")||task.status!=="queued")continue; const ids=task.dependencies.filter((id)=>this.config.roles[this.store.getTask(id)?.role]?.sandbox==="workspace-write"), artifacts=ids.map((id)=>this.store.workerArtifact(id)); if(ids.length<2||artifacts.some((a)=>!a))continue; const barrier={schemaVersion:1,kind:"IntegrationBarrier",id:randomUUID(),deliveryRunId:task.deliveryRunId,blueprintId:task.blueprintId,wave:task.wave,baseSha:task.artifactBaseSha,inputArtifacts:artifacts.map((a)=>({artifactId:a.taskId,headSha:a.headSha})),status:"pending",createdAt:new Date().toISOString()}; this.store.createIntegrationBarrier(barrier);this.store.setIntegrationBarrier(task.id,barrier.id);progressed=true; } for(const pending of this.store.readyIntegrationBarriers(this.activeDeliveryRunId)){const barrier=this.store.claimIntegrationBarrier(pending.id);if(!barrier)continue;progressed=true;const result=await new Integrator({...this.config,processRunner:this.processRunner}).integrateBarrier({barrier,artifacts:barrier.inputArtifacts.map((i)=>this.store.workerArtifact(i.artifactId)),overlay:this.#workerOverlayContext().overlay});if(result.status!=="passed"){this.store.failIntegrationBarrier(barrier.id,result.error);continue;}const checkpoint={schemaVersion:1,kind:"IntegrationCheckpoint",id:randomUUID(),deliveryRunId:barrier.deliveryRunId,blueprintId:barrier.blueprintId,wave:barrier.wave,baseSha:barrier.baseSha,inputArtifacts:barrier.inputArtifacts,outputSha:result.outputSha,verificationResults:result.verificationResults,status:"passed",createdAt:new Date().toISOString()};this.store.recordIntegrationCheckpoint(checkpoint,{barrierId:barrier.id});this.store.reconcileWave({deliveryRunId:barrier.deliveryRunId,wave:barrier.wave,checkpointId:checkpoint.id});for(const next of this.store.listTasks().filter((i)=>i.integrationBarrierId===barrier.id&&i.status==="queued"))this.store.setArtifactLineage(next.id,{artifactBaseSha:checkpoint.outputSha,artifactDependencies:[]});}return progressed; }
  #recordScopedFailure(task, detail) { const tasks=this.store.listTasks(), affected=new Set([task.id]);let changed=true;while(changed){changed=false;for(const candidate of tasks)if(!affected.has(candidate.id)&&candidate.dependencies.some((id)=>affected.has(id))){affected.add(candidate.id);changed=true;}}this.store.recordScopedReplan({id:randomUUID(),deliveryRunId:task.deliveryRunId,blueprintId:task.blueprintId,failedTaskId:task.id,invalidatedTaskIds:[...affected].filter((id)=>id!==task.id&&this.store.getTask(id)?.status==="queued"),priorPlanBatchId:task.planBatchId,status:"pending",createdAt:new Date().toISOString()}); }
  #inheritedWorktree(task) {
    let parent = task.parentTaskId ? this.store.getTask(task.parentTaskId) : null;
    while (parent) {
      if (parent.worktree) return { worktree: parent.worktree, branch: parent.branch };
      parent = parent.parentTaskId ? this.store.getTask(parent.parentTaskId) : null;
    }
    return null;
  }

  #validateDependencies(dependencies) {
    if (!Array.isArray(dependencies)) throw new Error("dependencies must be an array");
    for (const taskId of dependencies) {
      if (typeof taskId !== "string" || !this.store.getTask(taskId)) throw new Error(`Dependency task not found: ${taskId}`);
    }
  }

  #onNotification(message) {
    if (message.method === "account/rateLimits/updated") { this.account.onRateLimitsUpdated(message.params); return; }
    if (message.method !== "thread/tokenUsage/updated") return;
    const taskId = this.threadTasks.get(message.params.threadId);
    if (!taskId) return;
    if (this.store.getTask(taskId)?.status !== "running") return;
    // App Server may acknowledge turn/start with a client-facing ID and later
    // emit lifecycle events for its canonical turn ID. Budget interruption must
    // target the canonical ID, otherwise the upstream turn keeps running.
    this.#adoptResolvedTurnId(taskId, message.params.threadId, message.params.turnId);
    const reportedTokenUsed = this.governor.normalizeUsage(message.params);
    this.store.setTokenUsage(taskId, reportedTokenUsed, { source: "turn_last" });
    const tokenUsed = this.store.getTask(taskId)?.tokenUsed ?? reportedTokenUsed;
    const watchdog = this.#enforceUsageBudget(taskId, tokenUsed)
      .catch((error) => this.#lifecycle("budget watchdog failed", { taskId, error: String(error.message).slice(0, 300) }))
      .finally(() => this.pendingBudgetWatchdogs.delete(watchdog));
    this.pendingBudgetWatchdogs.add(watchdog);
  }

  #adoptResolvedTurnId(taskId, threadId, resolvedTurnId) {
    if (typeof resolvedTurnId !== "string" || !resolvedTurnId) return this.store.getTask(taskId);
    const task = this.store.getTask(taskId);
    if (!task || task.threadId !== threadId || task.turnId === resolvedTurnId) return task;
    const requestedTurnId = task.turnId;
    this.store.setThread(taskId, { threadId, turnId: resolvedTurnId });
    if (this.activeTurns.has(taskId)) {
      const active = this.activeTurns.get(taskId);
      this.activeTurns.set(taskId, { ...active, taskId, threadId, turnId: resolvedTurnId });
    }
    this.#lifecycle("turn id alias resolved", { taskId, threadId, requestedTurnId, resolvedTurnId });
    return this.store.getTask(taskId);
  }

  async #enforceUsageBudget(taskId, actualTokens) {
    if (!this.#enforcesLocalBudget()) return;
    const task = this.store.getTask(taskId);
    if (!task?.threadId || !task.turnId || task.status !== "running") return;
    const threshold = task.interruptThresholdTokens;
    if (!Number.isInteger(threshold) || actualTokens < threshold) return;
    if (this.budgetInterruptedTasks.has(taskId) || this.store.budgetInterruption(taskId)) return;
    this.budgetInterruptedTasks.add(taskId);
    const interruption = this.store.recordBudgetInterruption({
      taskId, deliveryRunId: task.deliveryRunId, threadId: task.threadId, turnId: task.turnId,
      actualTokens, interruptThresholdTokens: threshold, configuredBudgetCap: task.configuredBudgetCap ?? task.tokenBudget,
      reason: "budget_interrupt"
    });
    this.#lifecycle("budget interrupt requested", { taskId, threadId: task.threadId, turnId: task.turnId, actualTokens, threshold, configuredCap: task.configuredBudgetCap ?? task.tokenBudget, overshoot: interruption.capOvershootTokens });
    const confirmation = await this.#interruptAndAwaitTurn(this.activeClient, { taskId, threadId: task.threadId, turnId: task.turnId }, "budget_interrupt", { timeoutMs: this.config.delivery?.shutdownGraceMs ?? 3_000 });
    if (this.store.getTask(taskId)?.status === "running") this.store.transition(taskId, "blocked_budget", { error: `budget_interrupt: actual ${actualTokens}, threshold ${threshold}, configured cap ${task.configuredBudgetCap ?? task.tokenBudget}${confirmation.forced ? "; forced client shutdown" : ""}` });
    if (task.deliveryRunId) this.store.updateDeliveryRun(task.deliveryRunId, { state: "blocked_budget", publish: { reason: "budget_interrupt", taskId, interruption, recovery: { action: "Inspect persisted budget interruption and begin a fresh delivery run after increasing limits or reducing scope." } } });
  }

  #onProtocolEvent(event) {
    const taskId = event.threadId ? this.threadTasks.get(event.threadId) ?? null : null;
    if (event.method === "thread/tokenUsage/updated") {
      this.#lifecycle("token usage updated", { taskId, threadId: event.threadId, turnId: event.turnId, tokenUsage: event.tokenUsage });
    } else if (event.method === "item/started") {
      this.#lifecycle("item started", { taskId, threadId: event.threadId, turnId: event.turnId, itemType: event.itemType, itemStatus: event.itemStatus });
    } else if (event.method === "item/completed") {
      this.#lifecycle("item completed", { taskId, threadId: event.threadId, turnId: event.turnId, itemType: event.itemType, itemStatus: event.itemStatus });
    } else if (event.method === "turn/completed") {
      this.#lifecycle("turn completed", { taskId, threadId: event.threadId, turnId: event.turnId, itemStatus: event.itemStatus });
    } else if (event.method === "turn-id-alias") {
      this.#lifecycle("turn id alias resolved", { taskId, threadId: event.threadId, requestedTurnId: event.requestedTurnId, resolvedTurnId: event.resolvedTurnId });
    } else if (event.direction === "processExit") {
      this.#lifecycle("app-server exited", { error: event.errorMessage });
    }
  }

  #lifecycle(type, details = {}) {
    const event = { timestamp: new Date().toISOString(), type, ...details };
    this.lifecycleTrace.push(event);
    if (this.lifecycleTrace.length > 100) this.lifecycleTrace.splice(0, this.lifecycleTrace.length - 100);
    // The child process can emit its final exit event after the delivery CLI has
    // closed SQLite. Keep that late event in memory, but never touch a closed
    // store or turn a completed/blocked delivery into a launcher crash.
    if (this.closed) return event;
    // SQLite is the source of truth; JSONL is an operationally convenient
    // append-only mirror. Neither stores prompts, agent text, or payloads.
    this.store.recordEvent(details.taskId ?? null, `lifecycle/${type}`, event);
    mkdirSync(this.config.runtimeDir, { recursive: true });
    appendFileSync(this.lifecyclePath, `${JSON.stringify(event)}\n`, "utf8");
    this.emit("lifecycle", event);
    return event;
  }

  #onServerRequest(client, message) {
    const taskId = this.threadTasks.get(message.params?.threadId);
    if (!taskId) {
      if (message.params?.threadId && message.params?.turnId) this.#interruptAndAwaitTurn(client, { taskId: null, threadId: message.params.threadId, turnId: message.params.turnId }, "unexpected_unowned_turn", { timeoutMs: this.config.delivery?.shutdownGraceMs ?? 3_000 }).catch(() => {});
      return;
    }
    this.store.recordApproval({ requestId: message.id, taskId, method: message.method, payload: message.params, decision: "deny" });
    const task = this.store.getTask(taskId);
    this.#lifecycle("approval requested", { taskId, threadId: message.params?.threadId ?? null, turnId: message.params?.turnId ?? null, method: message.method });
    if (task.status === "running") this.store.transition(taskId, this.isAutonomous() ? "failed" : "awaiting_approval", { error: this.isAutonomous() ? `Unexpected App Server approval request in autonomous mode: ${message.method}` : `Approval requested: ${message.method}` });
    if (message.method === "item/commandExecution/requestApproval" || message.method === "item/fileChange/requestApproval") {
      client.respond(message.id, { decision: "cancel" });
    } else if (message.method === "item/permissions/requestApproval") {
      client.respond(message.id, { permissions: {}, scope: "turn" });
    } else {
      this.#interruptAndAwaitTurn(client, { taskId, threadId: message.params?.threadId, turnId: message.params?.turnId }, "unexpected_approval", { timeoutMs: this.config.delivery?.shutdownGraceMs ?? 3_000 }).catch(() => {});
    }
  }

  #validateChild(parentTaskId) {
    const parent = this.store.getTask(parentTaskId);
    if (!parent) throw new Error(`Parent task not found: ${parentTaskId}`);
    const depth = depthOf(parent, (id) => this.store.getTask(id));
    if (depth + 1 > this.config.router.maxDelegationDepth) throw new Error("Delegation depth limit reached");
    if (this.store.childCount(parentTaskId) >= this.config.router.maxChildrenPerTask) throw new Error("Child task limit reached");
  }

  #rootId(task) {
    let cursor = task;
    while (cursor.parentTaskId) cursor = this.store.getTask(cursor.parentTaskId);
    return cursor.id;
  }

  #plannerAncestor(task) {
    let cursor = task.parentTaskId ? this.store.getTask(task.parentTaskId) : null;
    while (cursor) {
      if (cursor.role === "planner") return cursor;
      cursor = cursor.parentTaskId ? this.store.getTask(cursor.parentTaskId) : null;
    }
    return null;
  }
}
