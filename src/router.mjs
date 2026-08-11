import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { AppServerClient } from "./app-server-client.mjs";
import { BudgetGovernor } from "./budget-governor.mjs";
import { depthOf, finalStatusForRole, assertRole, ENGINEERING_DOMAINS } from "./domain.mjs";
import { StateStore } from "./state-store.mjs";
import { WorktreeManager } from "./worktree-manager.mjs";
import { extractOrchestrationJson, validateBootstrap, validatePlan } from "./workflow-contract.mjs";
import { BudgetAccountAdapter } from "./budget-account-adapter.mjs";
import { commandCwd, commandsForPaths, generateProjectOverlay, loadProjectOverlay, projectOverlayExecutionSnapshot } from "./project-overlay.mjs";
import { WorktreeFinalizer } from "./worktree-finalizer.mjs";
import { Integrator } from "./integrator.mjs";
import { remediationScope, validateQualityGateReport } from "./quality-gate.mjs";
import { validateSecurityGateReport } from "./security-gate.mjs";
import { GitHubCiAdapter, GitHubMergeAdapter, GitHubPullRequestAdapter, RemoteAdapterError, RemoteCiAdapter, RemoteGitAdapter } from "./remote-adapters.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

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

export class SwarmRouter extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.store = new StateStore(join(config.runtimeDir, "swarm.sqlite"));
    this.governor = new BudgetGovernor(config.router);
    this.worktrees = new WorktreeManager(config);
    this.threadTasks = new Map();
    this.account = new BudgetAccountAdapter(this.store);
    this.finalizer = new WorktreeFinalizer({ repository: config.repository, generatedDir: config.project.generatedDir, autonomy: config.autonomy });
    this.lifecycleTrace = [];
    this.lastAppServerDiagnostics = null;
    this.lifecyclePath = join(config.runtimeDir, "lifecycle.jsonl");
    this.activeDeliveryRunId = null;
    this.activeDeliverySessionId = null;
    this.stopRequested = false;
    this.expectedClientShutdown = false;
    this.budgetInterruptedTasks = new Set();
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
    this.activeClient?.shutdown();
  }

  async requestShutdown(reason = "interrupted_controller_exit") {
    if (this.stopRequested) return;
    this.stopRequested = true;
    const client = this.activeClient;
    const active = [...this.activeTurns.values()];
    this.#lifecycle("controller shutdown requested", { reason, activeTurns: active.map(({ taskId, threadId, turnId }) => ({ taskId, threadId, turnId })) });
    if (client) {
      await Promise.race([
        Promise.allSettled(active.map(({ threadId, turnId }) => client.interruptTurn({ threadId, turnId }))),
        new Promise((resolve) => setTimeout(resolve, this.config.delivery?.shutdownGraceMs ?? 3_000))
      ]);
    }
    this.#markInterrupted(reason, { activeTurns: active.map(({ taskId, threadId, turnId }) => ({ taskId, threadId, turnId })) });
    client?.shutdown();
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
    if (run && !["interrupted", "completed_merged", "failed", "blocked_budget", "blocked_quota", "blocked_credentials", "blocked_ci", "blocked_branch_protection", "conflict_blocked"].includes(run.state)) return this.store.interruptDeliveryRun(run.id, { reason, recovery });
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

  activateDeliveryRun(runId) { this.activeDeliveryRunId = runId; }

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

  enqueue({ role, title, prompt, parentTaskId = null, allowedPaths = [], acceptanceChecks = [], dependencies = [], estimatedTokens = null, humanApprovalRequired = false, riskFlags = [], supportingDomains = [], artifactBaseSha = null, artifactDependencies = [], remediationRound = 0, sourceWriterTaskId = null, deliveryRunId = this.activeDeliveryRunId }) {
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
      riskFlags, supportingDomains, artifactBaseSha, artifactDependencies, remediationRound, sourceWriterTaskId, deliveryRunId
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
    const artifacts = ids.map((id) => {
      const artifact = this.store.workerArtifact(id);
      if (!artifact) throw new Error(`Task ${id} has no finalized WorkerArtifact`);
      return artifact;
    });
    const { overlay } = loadProjectOverlay(this.config.repository, this.config.project.generatedDir);
    const result = await new Integrator(this.config).integrate({ artifacts, overlay });
    this.store.recordIntegrationManifest(result.path, result.manifest);
    return result;
  }

  async publishCandidate(integration, { confirmRemotePush = false, remoteGitAdapter = null, pullRequestAdapter = null, remoteCiAdapter = null, mergeAdapter = null } = {}) {
    const manifest = integration?.manifest;
    if (!manifest || !["candidate_ready", "awaiting_human_merge"].includes(manifest.status) || manifest.localVerification?.status !== "passed") return { terminalState: "conflict_blocked", status: "conflict_blocked", reason: manifest?.blockedReason ?? "No locally verified candidate integration manifest" };
    const remote = this.config.remote ?? {};
    const autonomy = { mode: "autonomous", autoPush: true, autoCreatePullRequest: true, autoMerge: true, autoRemediate: true, ...(this.config.autonomy ?? {}) };
    const autonomous = this.isAutonomous();
    const auto = autonomous && autonomy.autoPush && autonomy.autoCreatePullRequest && autonomy.autoMerge;
    if (!remote.enabled || (!auto && !confirmRemotePush)) return { terminalState: autonomous ? "blocked_credentials" : "awaiting_human", status: autonomous ? "blocked_remote" : "awaiting_human_remote_handoff", reason: remote.enabled ? "Remote publication is disabled by autonomy policy." : "Remote publication is disabled in config.", candidate: { branch: manifest.branch, sha: manifest.candidateSha } };
    const candidate = { branch: manifest.branch, sha: manifest.candidateSha, base: this.config.baseRef };
    const failure = (error, stage, extra = {}) => {
      const code = error instanceof RemoteAdapterError ? error.code : "remote_failed";
      const terminalState = code === "credentials" ? "blocked_credentials" : code === "branch_protection" ? "blocked_branch_protection" : stage === "ci" ? "blocked_ci" : "failed";
      return { terminalState, status: terminalState, stage, reason: String(error.message ?? error).slice(0, 500), candidate, recovery: { action: "Inspect the persisted remote action and resolve the stated remote condition; rerun the launcher to resume idempotently." }, ...extra };
    };
    const runAction = async ({ key, kind, action }) => {
      let stored = this.store.externalAction(key);
      if (stored?.status === "passed") return stored.payload;
      if (!stored) this.store.recordExternalAction({ idempotencyKey: key, kind, status: "started", payload: { candidate } });
      try {
        const payload = await action();
        this.store.updateExternalAction(key, { status: payload?.status === "failed" || payload?.status === "timed_out" ? "failed" : "passed", payload });
        return payload;
      } catch (error) {
        this.store.updateExternalAction(key, { status: "failed", payload: { reason: String(error.message ?? error).slice(0, 500), code: error.code ?? null } });
        throw error;
      }
    };
    try {
      const pushKey = `push:${remote.remoteName}:${candidate.branch}:${candidate.sha}`;
      const remotePush = await runAction({ key: pushKey, kind: "remote-push", action: () => (remoteGitAdapter ?? new RemoteGitAdapter({ repository: this.config.repository, remoteName: remote.remoteName, allowedRemotes: remote.allowedRemotes, branchPrefix: remote.candidateBranchPrefix })).pushCandidate({ branch: candidate.branch, sha: candidate.sha, confirmRemotePush: auto || confirmRemotePush, idempotencyKey: pushKey }) });
      if (!autonomy.autoCreatePullRequest && !confirmRemotePush) return { terminalState: "awaiting_human", status: "awaiting_human_remote_handoff", candidate, remotePush, reason: "Candidate is pushed; manual PR mode is active." };
      const prKey = `pr:${candidate.branch}:${candidate.base}:${candidate.sha}`;
      const pullRequest = await runAction({ key: prKey, kind: "pull-request", action: async () => {
        const adapter = pullRequestAdapter ?? new GitHubPullRequestAdapter({ repository: this.config.repository });
        if (typeof adapter.ensurePullRequest === "function") return adapter.ensurePullRequest({ branch: candidate.branch, base: candidate.base, sha: candidate.sha, idempotencyKey: prKey });
        if (typeof adapter.handoff === "function") return adapter.handoff(candidate);
        throw new RemoteAdapterError("pr_create_failed", "Configured pull request adapter cannot create a pull request.");
      } });
      if (!pullRequest?.number) throw new RemoteAdapterError("pr_create_failed", "Pull request adapter did not return a PR number.");
      const ciKey = `ci:${pullRequest.number}:${candidate.sha}`;
      const remoteCi = await runAction({ key: ciKey, kind: "remote-ci", action: async () => {
        const adapter = remoteCiAdapter ?? new GitHubCiAdapter({ repository: this.config.repository, timeoutMs: remote.ciTimeoutMs, pollIntervalMs: remote.ciPollIntervalMs });
        return typeof adapter.waitForChecks === "function" ? adapter.waitForChecks({ pullRequest, candidate }) : adapter.verify(candidate);
      } });
      if (remote.requireCi && remoteCi.status !== "passed") return { terminalState: "blocked_ci", status: "blocked_ci", candidate, remotePush, pullRequest, remoteCi, reason: remoteCi.reason ?? "Required remote CI is not green.", recovery: { action: "Read the persisted CI failure summary. A CI-only failure has no safely scoped source remediation artifact, so the candidate is retained without a forced merge." } };
      if (!autonomy.autoMerge && !confirmRemotePush) return { terminalState: "completed_candidate_ready", status: "completed_candidate_ready", candidate, remotePush, pullRequest, remoteCi };
      const mergeKey = `merge:${pullRequest.number}:${candidate.sha}`;
      const merge = await runAction({ key: mergeKey, kind: "pull-request-merge", action: () => (mergeAdapter ?? new GitHubMergeAdapter({ repository: this.config.repository, mergeMethod: remote.mergeMethod })).merge({ pullRequest, candidate, base: candidate.base, idempotencyKey: mergeKey }) });
      if (merge.status !== "merged" || !merge.mainSha) throw new RemoteAdapterError("merge_verify_failed", "Merge adapter did not verify main after merge.");
      return { terminalState: "completed_merged", status: "completed_merged", candidate, remotePush, pullRequest, remoteCi, merge };
    } catch (error) {
      return failure(error, error?.code?.startsWith("ci") ? "ci" : error?.code?.startsWith("pr") ? "pull-request" : error?.code?.startsWith("merge") || error?.code === "branch_protection" ? "merge" : "push");
    }
  }

  async runToIntegration({ alreadyIdle = false } = {}) {
    const gates = this.store.listTasks().filter((task) => ["awaiting_human", "awaiting_approval"].includes(task.status));
    if (gates.length) throw new Error(`Run-to-integration refuses to bypass human gates: ${gates.map((task) => task.id).join(", ")}`);
    if (!alreadyIdle) await this.runUntilIdle();
    const tasks = this.store.listTasks();
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
    const existingBootstrap = this.store.listTasks().find((task) => task.role === "bootstrap" && !task.parentTaskId && !["done", "failed", "cancelled", "blocked_budget", "interrupted"].includes(task.status));
    if (existingBootstrap) return existingBootstrap;
    const activeTasks = this.store.listTasks().filter((task) => !["done", "failed", "cancelled", "blocked_budget", "interrupted"].includes(task.status));
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
    await this.worktrees.verifyRepository();
    this.#validateWorkerOverlays();
    const client = this.config.appServerClientFactory?.({ cwd: this.config.repository }) ?? new AppServerClient({ cwd: this.config.repository });
    this.activeClient = client;
    this.activeDeliveryRunId = deliveryRunId ?? null;
    this.stopRequested = false;
    this.expectedClientShutdown = false;
    this.budgetInterruptedTasks.clear();
    this.activeTurns.clear();
    this.activeDeliverySessionId = deliveryRunId ? randomUUID() : null;
    if (deliveryRunId) this.store.claimDeliveryLease(deliveryRunId, { ownerPid: process.pid, ownerSessionId: this.activeDeliverySessionId });
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
      return { blockedQuota: scheduler.blockedQuota, blockedBudget: scheduler.blockedBudget || this.budgetInterruptedTasks.size > 0, failed: scheduler.failed, interrupted: this.stopRequested, quota: this.quotaThrottleStatus() };
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      process.removeListener("SIGINT", onSigint);
      this.lastAppServerDiagnostics = client.diagnostics();
      this.expectedClientShutdown = true;
      client.shutdown();
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
      const task = this.store.claimNext();
      if (!task) {
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
          this.store.transition(task.id, "failed", { error: detail });
          await this.#failFastAfterTaskFailure(client, scheduler, task.id, detail);
        }
      } finally { scheduler.active -= 1; }
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
    await client.setGoal({ threadId, objective: `${task.title}\n\n${task.prompt}`, status: "active", tokenBudget: task.tokenBudget });
    const turnOptions = { threadId, input: [{ type: "text", text: this.#taskPrompt(task, worktree, overlayContext?.snapshot) }] };
    // The generated App Server schema explicitly allows `effort`; it does not
    // expose any server-side max-token field for turn/start.
    if (["bootstrap", "planner"].includes(task.role)) turnOptions.effort = "low";
    const turnResult = await client.startTurn(turnOptions);
    const turnId = turnResult.turn.id;
    this.store.setThread(task.id, { threadId, turnId });
    this.activeTurns.set(task.id, { taskId: task.id, threadId, turnId });
    this.#lifecycle("turn started", { taskId: task.id, threadId, turnId });
    const turn = await client.waitForTurn(threadId, turnId, this.config.router.turnTimeoutMs);
    const resolvedTurnId = turn.id ?? turnId;
    this.#adoptResolvedTurnId(task.id, threadId, resolvedTurnId);
    this.activeTurns.delete(task.id);
    const current = this.store.getTask(task.id);
    if (["awaiting_approval", "blocked_budget", "interrupted"].includes(current.status)) return;
    if (turn.status === "completed") {
      const resultText = await this.#readAgentResult(client, threadId, resolvedTurnId);
      let resultPath;
      if (task.role === "bootstrap") validateBootstrap(extractOrchestrationJson(resultText));
      if (task.role === "planner") this.#materializePlan(task, extractOrchestrationJson(resultText));
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
        if (this.#isScaffoldTask(task)) overlayContext = await this.#refreshProjectOverlayFromWorktree(worktree);
        const finalized = await this.finalizer.finalize({ task, worktree, branch, overlay: overlayContext.overlay, overlayPath: overlayContext.path });
        this.store.recordWorkerArtifact(task.id, finalized.path, finalized.artifact);
        if (this.#isScaffoldTask(task)) this.#connectScaffoldDependents(task, finalized.artifact);
      }
      this.store.transition(task.id, finalStatusForRole(task.role, { autonomous: this.isAutonomous() }));
      if (task.role === "bootstrap" && this.isAutonomous()) this.#enqueuePlanner(task);
    }
    else if (turn.status === "interrupted") this.store.transition(task.id, "interrupted", { error: "Turn interrupted" });
    else this.store.transition(task.id, "failed", { error: turn.error?.message ?? "Turn failed" });
  }

  #taskPrompt(task, worktree, overlaySnapshot) {
    const scaffoldRequirement = this.#isScaffoldTask(task) ? "MANDATORY PRODUCT SCAFFOLD: execute the scaffold now in this worktree; do not return an analysis or plan. Create every declared product root: a runnable Next.js frontend with package.json, lockfile, build/test scripts; and an ASP.NET Core Web API solution plus xUnit test project. Verify files exist with git status/diff before finishing. Returning with no changed files is a task failure." : null;
    return [
      formatTaskPrompt({ task, worktree, project: this.config.project, overlaySnapshot, documentationAvailable: existsSync(join(this.config.repository, this.config.project.documentationDir, "inventory.json")) }),
      scaffoldRequirement,
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
        await exec(command.executable, command.args, { cwd: commandCwd(worktree, command), timeout: command.timeoutMs ?? 120_000, windowsHide: true });
        passed.push({ id: command.id, source: "controller", status: "passed" });
      } catch (error) {
        failed.push({ id: command.id, source: "controller", status: "failed", error: String(error.message).slice(0, 500) });
      }
    }
    if (!plan.commands.length && !plan.missing.length) notRun.push({ id: "declared-verification", reason: "No changed scaffolded product component requires verification" });
    return { passed, failed, notRun };
  }

  #enqueuePlanner(bootstrapTask) {
    const existing = this.store.listTasks().find((task) => task.role === "planner" && task.parentTaskId === bootstrapTask.id);
    if (existing) return existing;
    return this.enqueue({
      role: "planner",
      parentTaskId: bootstrapTask.id,
      title: `Plan ${this.config.project.name}`,
      prompt: `Use the Bootstrap blueprint at ${bootstrapTask.resultPath}. Produce the required JSON execution DAG. For this greenfield multi-stack contract, include a devops writer task with id scaffold-product that creates every declared product root before any task writing under frontend/ or backend/.`,
      dependencies: [bootstrapTask.id], estimatedTokens: this.config.roles.planner.tokenBudget,
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
      return this.store.securityReport(security?.id)?.report.verdict === "pass" && this.store.qualityReport(quality?.id)?.report.verdict === "pass";
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
      sourceWriterTaskId: null
    });
    const security = this.enqueue({
      role: "security", parentTaskId: remediation.id, title: `Security review: ${remediation.title}`,
      prompt: `Review the finalized remediation artifact for '${writer.title}'. Do not expand scope; report only concrete security findings.`,
      allowedPaths, acceptanceChecks: report.findings.map((finding) => finding.verification), dependencies: [remediation.id],
      estimatedTokens: Math.min(this.config.roles.security.tokenBudget, Math.max(1, Math.ceil(remediation.estimatedTokens * 0.35))),
      riskFlags: writer.riskFlags, supportingDomains: ["security"], sourceWriterTaskId: remediation.id
    });
    this.enqueue({
      role: "qa", parentTaskId: security.id, title: `QA: ${remediation.title}`,
      prompt: `Verify the finalized remediation artifact for '${writer.title}'. Return the required QualityGateReport only.`,
      allowedPaths, acceptanceChecks: report.findings.map((finding) => finding.verification), dependencies: [security.id],
      estimatedTokens: Math.min(this.config.roles.qa.tokenBudget, Math.max(1, Math.ceil(remediation.estimatedTokens * 0.4))),
      riskFlags: writer.riskFlags, supportingDomains: ["qa"], sourceWriterTaskId: remediation.id
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
    const remediation = this.enqueue({ role: writer.role, parentTaskId: task.id, title: `Remediate ${writer.title} (security round ${nextRound})`, prompt: `Apply only these validated SecurityGate findings. Do not expand scope or risk: ${JSON.stringify(report.findings.map((finding) => ({ id: finding.id, path: finding.path, requiredFix: finding.requiredFix, verification: finding.verification })))}.`, allowedPaths, acceptanceChecks: report.findings.map((finding) => finding.verification), dependencies: [task.id], estimatedTokens: Math.min(this.config.roles[writer.role].tokenBudget, writer.estimatedTokens), riskFlags: writer.riskFlags, supportingDomains: ["security", "qa"], artifactBaseSha: predecessor.artifact.headSha, artifactDependencies: [writer.id], remediationRound: nextRound });
    const security = this.enqueue({ role: "security", parentTaskId: remediation.id, title: `Security review: ${remediation.title}`, prompt: `Review the finalized security remediation artifact for '${writer.title}'. Return the required SecurityGateReport only.`, allowedPaths, acceptanceChecks: remediation.acceptanceChecks, dependencies: [remediation.id], estimatedTokens: Math.min(this.config.roles.security.tokenBudget, Math.max(1, Math.ceil(remediation.estimatedTokens * 0.35))), riskFlags: writer.riskFlags, supportingDomains: ["security"], sourceWriterTaskId: remediation.id });
    this.enqueue({ role: "qa", parentTaskId: security.id, title: `QA: ${remediation.title}`, prompt: `Verify the finalized security remediation artifact for '${writer.title}'. Return the required QualityGateReport only.`, allowedPaths, acceptanceChecks: remediation.acceptanceChecks, dependencies: [security.id], estimatedTokens: Math.min(this.config.roles.qa.tokenBudget, Math.max(1, Math.ceil(remediation.estimatedTokens * 0.4))), riskFlags: writer.riskFlags, supportingDomains: ["qa"], sourceWriterTaskId: remediation.id });
    this.store.transition(task.id, "done");
    this.#lifecycle("security remediation queued", { taskId: remediation.id, writerTaskId: writer.id, remediationRound: nextRound });
  }

  #structuredOutputContract(role) {
    if (role === "bootstrap") return `Return only one fenced JSON object with this schema:\n{"summary":"string","assumptions":["string"],"risks":["string"],"humanGates":["string"]}`;
    if (role === "planner") return `Return only one fenced JSON object with this schema:\n{"tasks":[{"id":"safe-kebab-id","title":"string","prompt":"specific implementation instruction","primaryDomain":"backend|frontend|database|qa|security|devops","supportingDomains":["qa|security|..."],"riskFlags":["public_api_change|schema_change|..."],"humanApprovalRequired":false,"estimatedTokens":8000,"dependsOn":["other-task-id"],"allowedPaths":["path"],"acceptanceChecks":["test or check"]}]}. allowedPaths must be explicit. Auth, network, permission, sensitive-data and supply-chain flags require security. Schema/destructive work must use database and humanApprovalRequired=true. Do not create implementation tasks for ambiguity; report it to the human instead.`;
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

  #materializePlan(plannerTask, parsedPlan) {
    const plan = validatePlan(parsedPlan, { maxTasks: this.config.router.maxPlanTasks, productRoots: this.config.project.productRoots });
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
    const specs = [];
    // Build and validate the whole dispatch graph before making one atomic
    // StateStore write. This prevents a rejected route from leaving a partial DAG.
    for (const { item, elevatedGate, securityRequired, dependencyPlanIds } of dispatch) {
      const primary = assertRoute(item.primaryDomain, item.estimatedTokens);
      const primaryId = primaryIds.get(item.id);
      const dependencies = [plannerTask.id, ...dependencyPlanIds.map((dependency) => primaryIds.get(dependency))];
      if (scaffoldTaskId && item.id !== "scaffold-product" && primary.sandbox === "workspace-write" && !dependencies.includes(scaffoldTaskId)) dependencies.push(scaffoldTaskId);
      specs.push({ id: primaryId, role: item.primaryDomain, parentTaskId: plannerTask.id, title: item.title, prompt: item.id === "scaffold-product" ? `[[product-scaffold]]\n${item.prompt}` : item.prompt, allowedPaths: item.allowedPaths, acceptanceChecks: item.acceptanceChecks, dependencies, estimatedTokens: item.estimatedTokens, tokenBudget: primary.tokenBudget, maxAttempts: 1, humanApprovalRequired: elevatedGate, riskFlags: item.riskFlags, supportingDomains: item.supportingDomains, deliveryRunId: plannerTask.deliveryRunId ?? this.activeDeliveryRunId });
      let predecessorId = primaryId;
      const mandatoryReview = primary.sandbox === "workspace-write";
      if ((mandatoryReview || securityRequired) && item.primaryDomain !== "security") {
        const estimate = Math.min(this.config.roles.security?.tokenBudget ?? 0, Math.max(1000, Math.ceil(item.estimatedTokens * 0.35)));
        const security = assertRoute("security", estimate);
        predecessorId = randomUUID();
        specs.push({ id: predecessorId, role: "security", parentTaskId: primaryId, title: `Security review: ${item.title}`, prompt: `Review finalized writer artifact '${item.title}' for declared risk flags: ${item.riskFlags.join(", ") || "none"}. Return the required SecurityGateReport only.`, allowedPaths: item.allowedPaths, acceptanceChecks: item.acceptanceChecks, dependencies: [primaryId], estimatedTokens: estimate, tokenBudget: security.tokenBudget, maxAttempts: 1, humanApprovalRequired: false, riskFlags: item.riskFlags, supportingDomains: ["security"], sourceWriterTaskId: primaryId, deliveryRunId: plannerTask.deliveryRunId ?? this.activeDeliveryRunId });
      }
      if ((mandatoryReview || item.supportingDomains.includes("qa")) && item.primaryDomain !== "qa") {
        const estimate = Math.min(this.config.roles.qa?.tokenBudget ?? 0, Math.max(1000, Math.ceil(item.estimatedTokens * 0.4)));
        const qa = assertRoute("qa", estimate);
        specs.push({ id: randomUUID(), role: "qa", parentTaskId: predecessorId, title: `QA: ${item.title}`, prompt: `Verify finalized writer artifact '${item.title}' against acceptance checks. Return the required QualityGateReport only.`, allowedPaths: item.allowedPaths, acceptanceChecks: item.acceptanceChecks, dependencies: [predecessorId], estimatedTokens: estimate, tokenBudget: qa.tokenBudget, maxAttempts: 1, humanApprovalRequired: false, riskFlags: item.riskFlags, supportingDomains: ["qa"], sourceWriterTaskId: primaryId, deliveryRunId: plannerTask.deliveryRunId ?? this.activeDeliveryRunId });
      }
    }
    this.store.createTasks(specs);
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
    await Promise.allSettled(active.map(({ threadId, turnId }) => client.interruptTurn({ threadId, turnId })));
  }

  #connectScaffoldDependents(scaffoldTask, artifact) {
    for (const task of this.store.listTasks()) {
      if (task.id === scaffoldTask.id || !task.dependencies.includes(scaffoldTask.id) || this.config.roles[task.role]?.sandbox !== "workspace-write") continue;
      this.store.setArtifactLineage(task.id, { artifactBaseSha: artifact.headSha, artifactDependencies: [scaffoldTask.id] });
    }
  }
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
    // App Server may acknowledge turn/start with a client-facing ID and later
    // emit lifecycle events for its canonical turn ID. Budget interruption must
    // target the canonical ID, otherwise the upstream turn keeps running.
    this.#adoptResolvedTurnId(taskId, message.params.threadId, message.params.turnId);
    const reportedTokenUsed = this.governor.normalizeUsage(message.params);
    this.store.setTokenUsage(taskId, reportedTokenUsed);
    const tokenUsed = this.store.getTask(taskId)?.tokenUsed ?? reportedTokenUsed;
    this.#enforceUsageBudget(taskId, tokenUsed).catch((error) => this.#lifecycle("budget watchdog failed", { taskId, error: String(error.message).slice(0, 300) }));
  }

  #adoptResolvedTurnId(taskId, threadId, resolvedTurnId) {
    if (typeof resolvedTurnId !== "string" || !resolvedTurnId) return this.store.getTask(taskId);
    const task = this.store.getTask(taskId);
    if (!task || task.threadId !== threadId || task.turnId === resolvedTurnId) return task;
    const requestedTurnId = task.turnId;
    this.store.setThread(taskId, { threadId, turnId: resolvedTurnId });
    if (this.activeTurns.has(taskId)) this.activeTurns.set(taskId, { taskId, threadId, turnId: resolvedTurnId });
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
    // Persist terminal state before requesting the best-effort upstream interrupt;
    // late token notifications can therefore only enrich the recorded overshoot.
    this.store.transition(taskId, "blocked_budget", { error: `budget_interrupt: actual ${actualTokens}, threshold ${threshold}, configured cap ${task.configuredBudgetCap ?? task.tokenBudget}` });
    if (task.deliveryRunId) this.store.updateDeliveryRun(task.deliveryRunId, { state: "blocked_budget", publish: { reason: "budget_interrupt", taskId, interruption, recovery: { action: "Inspect persisted budget interruption and begin a fresh delivery run after increasing limits or reducing scope." } } });
    await this.activeClient?.interruptTurn({ threadId: task.threadId, turnId: task.turnId });
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
      if (message.params?.threadId && message.params?.turnId) client.interruptTurn({ threadId: message.params.threadId, turnId: message.params.turnId }).catch(() => {});
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
      client.interruptTurn({ threadId: message.params?.threadId, turnId: message.params?.turnId }).catch(() => {});
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
