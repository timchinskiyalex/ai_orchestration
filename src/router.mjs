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
import { generateProjectOverlay, loadProjectOverlay, projectOverlayExecutionSnapshot } from "./project-overlay.mjs";
import { WorktreeFinalizer } from "./worktree-finalizer.mjs";
import { Integrator } from "./integrator.mjs";
import { remediationScope, requiresHumanQualityGate, validateQualityGateReport } from "./quality-gate.mjs";
import { validateSecurityGateReport } from "./security-gate.mjs";
import { RemoteCiAdapter, RemoteGitAdapter } from "./remote-adapters.mjs";
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
    this.finalizer = new WorktreeFinalizer({ repository: config.repository, generatedDir: config.project.generatedDir });
    this.lifecycleTrace = [];
    this.lastAppServerDiagnostics = null;
    this.lifecyclePath = join(config.runtimeDir, "lifecycle.jsonl");
  }

  init() {
    mkdirSync(this.config.runtimeDir, { recursive: true });
    return { runtimeDir: this.config.runtimeDir, database: join(this.config.runtimeDir, "swarm.sqlite") };
  }

  close() { this.stop(); this.store.close(); }

  stop() {
    if (this.activeClient) this.lastAppServerDiagnostics = this.activeClient.diagnostics();
    this.activeClient?.shutdown();
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

  enqueue({ role, title, prompt, parentTaskId = null, allowedPaths = [], acceptanceChecks = [], dependencies = [], estimatedTokens = null, humanApprovalRequired = false, riskFlags = [], supportingDomains = [], artifactBaseSha = null, artifactDependencies = [], remediationRound = 0, sourceWriterTaskId = null }) {
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
      riskFlags, supportingDomains, artifactBaseSha, artifactDependencies, remediationRound, sourceWriterTaskId
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
      tasks: tasks.map((task) => ({ id: task.id, title: task.title, role: task.role, status: task.status, dependencies: task.dependencies, blocker: task.error ?? null, tokenUsed: task.tokenUsed, estimatedTokens: task.estimatedTokens, threadId: task.threadId, turnId: task.turnId, worktree: task.worktree, remediationRound: task.remediationRound })),
      activeTurns: tasks.filter((task) => task.status === "running").map((task) => ({ taskId: task.id, threadId: task.threadId, turnId: task.turnId })),
      realConcurrency: tasks.filter((task) => task.status === "running").length,
      localBudget: readiness.localBudget,
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
      label: `local rolling ${this.config.budget.weeklyWindowDays}-day budget`, windowStartedAt: since, weeklyTokenLimit: limit, usedTokens: usage.used,
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
    return generateProjectOverlay({ repository: this.config.repository, baseRef: this.config.baseRef, generatedDir: this.config.project.generatedDir });
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

  async publishCandidate(integration, { confirmRemotePush = false, remoteGitAdapter = null, remoteCiAdapter = null } = {}) {
    const manifest = integration?.manifest;
    if (!manifest || manifest.status !== "awaiting_human_merge") return { terminalState: "conflict_blocked", status: "conflict_blocked", reason: manifest?.blockedReason ?? "No verified candidate integration manifest" };
    const remote = this.config.remote ?? {};
    if (!confirmRemotePush || !remote.enabled) return { terminalState: "awaiting_human", status: "awaiting_human_remote_handoff", reason: "Remote push is disabled or requires explicit --confirm-remote-push", candidate: { branch: manifest.branch, sha: manifest.candidateSha } };
    const idempotencyKey = `push:${remote.remoteName}:${manifest.branch}:${manifest.candidateSha}`;
    let action = this.store.externalAction(idempotencyKey);
    if (!action) {
      this.store.recordExternalAction({ idempotencyKey, kind: "remote-push", status: "started", payload: { branch: manifest.branch, sha: manifest.candidateSha } });
      const adapter = remoteGitAdapter ?? new RemoteGitAdapter({ repository: this.config.repository, remoteName: remote.remoteName, allowedRemotes: remote.allowedRemotes, branchPrefix: remote.candidateBranchPrefix });
      try {
        const pushed = await adapter.pushCandidate({ branch: manifest.branch, sha: manifest.candidateSha, confirmRemotePush, idempotencyKey });
        action = this.store.updateExternalAction(idempotencyKey, { status: "passed", payload: pushed });
      } catch (error) {
        this.store.updateExternalAction(idempotencyKey, { status: "failed", payload: { reason: String(error.message).slice(0, 500) } });
        return { terminalState: "awaiting_human", status: "awaiting_human_remote_handoff", reason: "Remote push failed; inspect recorded recovery", candidate: { branch: manifest.branch, sha: manifest.candidateSha } };
      }
    }
    if (action.status !== "passed") return { terminalState: "awaiting_human", status: "awaiting_human_remote_handoff", reason: "Remote push has incomplete recovery state" };
    const ci = await (remoteCiAdapter ?? new RemoteCiAdapter()).verify({ branch: manifest.branch, sha: manifest.candidateSha });
    if (remote.requireCi && ci.status !== "passed") return { terminalState: "awaiting_human", status: "awaiting_human_remote_handoff", reason: ci.reason ?? "Configured remote CI is not passed", remotePush: action.payload, remoteCi: ci };
    return { terminalState: "completed_candidate_ready", status: "completed_candidate_ready", candidate: { branch: manifest.branch, sha: manifest.candidateSha }, remotePush: action.payload, remoteCi: ci, humanMergeGate: manifest.humanMergeGate };
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
    const security = tasks.filter((task) => task.role === "security" && task.sourceWriterTaskId);
    const quality = tasks.filter((task) => task.role === "qa" && task.sourceWriterTaskId);
    const missingSecurity = security.filter((task) => this.store.securityReport(task.id)?.report.verdict !== "pass");
    const missingQuality = quality.filter((task) => this.store.qualityReport(task.id)?.report.verdict !== "pass");
    if (missingSecurity.length || missingQuality.length) throw new Error(`Run-to-integration requires passed Security and QA reports: ${[...missingSecurity, ...missingQuality].map((task) => task.id).join(", ")}`);
    const result = await this.integrateFinalized(writerIds);
    return { writerArtifacts: writerIds.map((id) => this.store.workerArtifact(id)), integration: result, nextAction: result.manifest.status === "awaiting_human_merge" ? "Review local verification and explicitly create a PR or perform the SHA-bound merge." : "Resolve the blocked integration and retry." };
  }

  startProject() {
    const inventory = join(this.config.repository, this.config.project.documentationDir, "inventory.json");
    if (!existsSync(inventory)) throw new Error(`Project documentation has not been imported: ${inventory}`);
    const existingBootstrap = this.store.listTasks().find((task) => task.role === "bootstrap" && !task.parentTaskId);
    if (existingBootstrap) return existingBootstrap;
    if (this.store.listTasks().length) throw new Error("This instance already has orchestration tasks; create a fresh instance for another project run");
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
    const planner = this.enqueue({
      role: "planner",
      parentTaskId: task.id,
      title: `Plan ${this.config.project.name}`,
      prompt: `Use the approved Bootstrap blueprint at ${task.resultPath}. Produce the required JSON execution DAG.`,
      dependencies: [task.id], estimatedTokens: this.config.roles.planner.tokenBudget,
    });
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

  async runUntilIdle() {
    await this.worktrees.verifyRepository();
    this.#validateWorkerOverlays();
    const client = this.config.appServerClientFactory?.({ cwd: this.config.repository }) ?? new AppServerClient({ cwd: this.config.repository });
    this.activeClient = client;
    client.on("notification", (message) => this.#onNotification(message));
    client.on("serverRequest", (message) => this.#onServerRequest(client, message));
    client.on("protocol", (event) => this.#onProtocolEvent(event));
    client.on("fatal", (error) => {
      if (error.message !== "App Server client closed") this.#lifecycle("app-server error", { error: "App Server client failure" });
    });
    client.on("exit", ({ code, signal }) => this.#lifecycle("app-server exited", { code, signal }));
    try {
      await client.connect();
      this.#lifecycle("app-server connected");
      const snapshot = await this.account.refresh(client);
      this.#lifecycle(snapshot.diagnostics?.length ? "account read failed" : "account read completed", { diagnostics: snapshot.diagnostics?.length ?? 0 });
      const scheduler = { active: 0 };
      const workers = Array.from({ length: this.config.router.maxConcurrentTasks }, () => this.#worker(client, scheduler));
      await Promise.all(workers);
    } finally {
      this.lastAppServerDiagnostics = client.diagnostics();
      client.shutdown();
      this.lastAppServerDiagnostics = client.diagnostics();
      if (this.activeClient === client) this.activeClient = null;
    }
  }

  async #worker(client, scheduler) {
    while (true) {
      if (this.quotaThrottleStatus().throttled) return;
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
        if (current && !["awaiting_approval", "cancelled"].includes(current.status)) {
          let recovery = null;
          if (current.worktree) {
            try { recovery = await this.worktrees.recovery(current.worktree); }
            catch { recovery = null; }
          }
          const detail = recovery ? `${error.message} Recovery worktree: ${recovery.worktree} (${recovery.clean ? "clean" : "dirty"}). ${recovery.action}` : error.message;
          this.store.transition(task.id, "failed", { error: detail });
        }
      } finally { scheduler.active -= 1; }
    }
  }

  async #runTask(client, task) {
    const roleConfig = this.config.roles[task.role];
    const overlayContext = ENGINEERING_DOMAINS.has(task.role) ? this.#workerOverlayContext() : null;
    if (ENGINEERING_DOMAINS.has(task.role)) {
      const planner = this.#plannerAncestor(task);
      const readiness = this.executionReadiness();
      if (readiness.localP90ProjectedTokens > readiness.localBudget.weeklyTokenLimit && (!planner || !this.store.budgetOverride(planner.id))) {
        this.store.transition(task.id, "blocked_budget", { error: "P90 local forecast requires a separately recorded human budget override" });
        return;
      }
    }
    const rootId = this.#rootId(task);
    const usage = this.store.usageForRoot(rootId);
    const decision = this.governor.canStart({ task, alreadyUsed: usage.used, alreadyReserved: Math.max(0, usage.reserved - task.tokenBudget), parentBudget: this.config.router.defaultParentBudget });
    if (!decision.allowed) {
      this.store.transition(task.id, "blocked_budget", { error: `Projected ${decision.projected} exceeds budget ${decision.budget}` });
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
    const turnResult = await client.startTurn({ threadId, input: [{ type: "text", text: this.#taskPrompt(task, worktree, overlayContext?.snapshot) }] });
    const turnId = turnResult.turn.id;
    this.store.setThread(task.id, { threadId, turnId });
    this.#lifecycle("turn started", { taskId: task.id, threadId, turnId });
    const turn = await client.waitForTurn(threadId, turnId, this.config.router.turnTimeoutMs);
    const resolvedTurnId = turn.id ?? turnId;
    if (resolvedTurnId !== turnId) {
      this.store.setThread(task.id, { threadId, turnId: resolvedTurnId });
      this.#lifecycle("turn id alias resolved", { taskId: task.id, threadId, requestedTurnId: turnId, resolvedTurnId });
    }
    const current = this.store.getTask(task.id);
    if (current.status === "awaiting_approval") return;
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
        const checks = await this.#runDeclaredVerification(worktree, overlayContext.overlay);
        report.executedChecks = [...report.executedChecks, ...checks.passed];
        report.notRunChecks = [...report.notRunChecks, ...checks.notRun];
        if (checks.failed.length) {
          report.verdict = "blocked";
          report.summary = "Controller verification failed; human review is required.";
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
        const finalized = await this.finalizer.finalize({ task, worktree, branch, overlay: overlayContext.overlay, overlayPath: overlayContext.path });
        this.store.recordWorkerArtifact(task.id, finalized.path, finalized.artifact);
      }
      this.store.transition(task.id, finalStatusForRole(task.role));
    }
    else if (turn.status === "interrupted") this.store.transition(task.id, "cancelled", { error: "Turn interrupted" });
    else this.store.transition(task.id, "failed", { error: turn.error?.message ?? "Turn failed" });
  }

  #taskPrompt(task, worktree, overlaySnapshot) {
    return [
      formatTaskPrompt({ task, worktree, project: this.config.project, overlaySnapshot, documentationAvailable: existsSync(join(this.config.repository, this.config.project.documentationDir, "inventory.json")) }),
      this.#structuredOutputContract(task.role),
      "Do not create child agents. Do not merge, push, modify Router configuration, or bypass approval/sandbox policy."
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

  async #runDeclaredVerification(worktree, overlay) {
    const passed = []; const failed = []; const notRun = [];
    for (const command of overlay.verificationCommands ?? []) {
      try {
        await exec(command.executable, command.args, { cwd: worktree, timeout: command.timeoutMs ?? 120_000, windowsHide: true });
        passed.push({ id: command.id, source: "controller", status: "passed" });
      } catch (error) {
        failed.push({ id: command.id, source: "controller", status: "failed", error: String(error.message).slice(0, 500) });
      }
    }
    if (!overlay.verificationCommands?.length) notRun.push({ id: "declared-verification", reason: "ProjectOverlay declared no verification command" });
    return { passed, failed, notRun };
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
    if (requiresHumanQualityGate(report, report.verdict === "remediation_required" && nextRound > maxRounds)) {
      this.store.transition(task.id, "awaiting_human", { error: report.verdict === "blocked" ? "Quality gate blocked" : "Quality findings require human escalation" });
      this.#lifecycle("quality gate awaiting human", { taskId: task.id, writerTaskId: writer.id, verdict: report.verdict });
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
    if (requiresHumanQualityGate(report, report.verdict === "remediation_required" && nextRound > maxRounds)) {
      this.store.transition(task.id, "awaiting_human", { error: report.verdict === "blocked" ? "Security gate blocked" : "Security findings require human escalation" });
      this.#lifecycle("security gate awaiting human", { taskId: task.id, writerTaskId: writer.id, verdict: report.verdict });
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
    const plan = validatePlan(parsedPlan, { maxTasks: this.config.router.maxPlanTasks });
    const orderedPlanIds = new Map();
    const pending = [...plan.tasks];
    const dispatch = [];
    while (pending.length) {
      const readyIndex = pending.findIndex((item) => item.dependsOn.every((dependency) => orderedPlanIds.has(dependency)));
      if (readyIndex === -1) throw new Error("Unable to topologically order the validated plan");
      const [item] = pending.splice(readyIndex, 1);
      const securityRequired = item.supportingDomains.includes("security") || item.riskFlags.some((flag) => ["auth_or_authorization", "secret_handling", "sensitive_data", "network_exposure", "permission_change", "dependency_supply_chain"].includes(flag));
      const elevatedGate = item.humanApprovalRequired || securityRequired || item.riskFlags.some((flag) => ["schema_change", "destructive_data_change", "irreversible_operation", "permission_change"].includes(flag));
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
    const specs = [];
    // Build and validate the whole dispatch graph before making one atomic
    // StateStore write. This prevents a rejected route from leaving a partial DAG.
    for (const { item, elevatedGate, securityRequired, dependencyPlanIds } of dispatch) {
      const primary = assertRoute(item.primaryDomain, item.estimatedTokens);
      const primaryId = primaryIds.get(item.id);
      specs.push({ id: primaryId, role: item.primaryDomain, parentTaskId: plannerTask.id, title: item.title, prompt: item.prompt, allowedPaths: item.allowedPaths, acceptanceChecks: item.acceptanceChecks, dependencies: [plannerTask.id, ...dependencyPlanIds.map((dependency) => primaryIds.get(dependency))], estimatedTokens: item.estimatedTokens, tokenBudget: primary.tokenBudget, maxAttempts: 1, humanApprovalRequired: elevatedGate, riskFlags: item.riskFlags, supportingDomains: item.supportingDomains });
      let predecessorId = primaryId;
      const mandatoryReview = primary.sandbox === "workspace-write";
      if ((mandatoryReview || securityRequired) && item.primaryDomain !== "security") {
        const estimate = Math.min(this.config.roles.security?.tokenBudget ?? 0, Math.max(1000, Math.ceil(item.estimatedTokens * 0.35)));
        const security = assertRoute("security", estimate);
        predecessorId = randomUUID();
        specs.push({ id: predecessorId, role: "security", parentTaskId: primaryId, title: `Security review: ${item.title}`, prompt: `Review finalized writer artifact '${item.title}' for declared risk flags: ${item.riskFlags.join(", ") || "none"}. Return the required SecurityGateReport only.`, allowedPaths: item.allowedPaths, acceptanceChecks: item.acceptanceChecks, dependencies: [primaryId], estimatedTokens: estimate, tokenBudget: security.tokenBudget, maxAttempts: 1, humanApprovalRequired: false, riskFlags: item.riskFlags, supportingDomains: ["security"], sourceWriterTaskId: primaryId });
      }
      if ((mandatoryReview || item.supportingDomains.includes("qa")) && item.primaryDomain !== "qa") {
        const estimate = Math.min(this.config.roles.qa?.tokenBudget ?? 0, Math.max(1000, Math.ceil(item.estimatedTokens * 0.4)));
        const qa = assertRoute("qa", estimate);
        specs.push({ id: randomUUID(), role: "qa", parentTaskId: predecessorId, title: `QA: ${item.title}`, prompt: `Verify finalized writer artifact '${item.title}' against acceptance checks. Return the required QualityGateReport only.`, allowedPaths: item.allowedPaths, acceptanceChecks: item.acceptanceChecks, dependencies: [predecessorId], estimatedTokens: estimate, tokenBudget: qa.tokenBudget, maxAttempts: 1, humanApprovalRequired: false, riskFlags: item.riskFlags, supportingDomains: ["qa"], sourceWriterTaskId: primaryId });
      }
    }
    this.store.createTasks(specs);
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
    this.store.setTokenUsage(taskId, this.governor.normalizeUsage(message.params));
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
    if (task.status === "running") this.store.transition(taskId, "awaiting_approval", { error: `Approval requested: ${message.method}` });
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
