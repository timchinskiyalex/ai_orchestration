import { randomUUID } from "node:crypto";
import { ingestDocumentation } from "./project-intake.mjs";
import { ENGINEERING_DOMAINS } from "./domain.mjs";

function manualGateFor(tasks) {
  const task = tasks.find((item) => ["awaiting_human", "awaiting_approval"].includes(item.status));
  if (!task) return null;
  return { taskId: task.id, status: task.status, reason: task.error ?? "Explicit manual workflow approval is required", approveCommand: `npm run approve -- --task ${task.id}`, resumeCommand: "npm run deliver -- --resume" };
}

function terminalForTask(task) {
  if (task.status === "blocked_budget") return { state: "blocked_budget", reason: task.error ?? "Local scheduler hard cap blocked task execution" };
  if (task.status === "awaiting_approval") return { state: "failed", reason: task.error ?? "Unexpected App Server approval request" };
  return { state: "failed", reason: task.error ?? task.status };
}

export class DeliveryCoordinator {
  constructor(router) { this.router = router; }

  async begin({ source, ...adapters }) {
    this.router.recoverStaleDeliveries();
    const current = this.router.store.currentDeliveryRun();
    if (current && ["running", "awaiting_human", "awaiting_human_remote_handoff"].includes(current.state)) throw new Error(`A delivery run is already active: ${current.id}. Use npm run deliver -- --resume.`);
    const intake = ingestDocumentation({ source, repository: this.router.config.repository, destinationRelative: this.router.config.project.documentationDir });
    const overlay = await this.router.ensureProjectOverlay();
    const bootstrap = this.router.startProject();
    const run = this.router.store.createDeliveryRun({ id: randomUUID(), source, bootstrapTaskId: bootstrap.id, confirmRemotePush: this.router.isAutonomous() });
    this.router.store.linkTaskToDelivery(bootstrap.id, run.id);
    this.router.activateDeliveryRun(run.id);
    return this.#advance(run, { intake, overlayPath: overlay.path, ...adapters });
  }

  async resume(adapters = {}) {
    this.router.recoverStaleDeliveries();
    const run = this.router.store.currentDeliveryRun();
    if (!run) throw new Error("No delivery run exists; start with npm run deliver -- --source <docs-dir>");
    if (["completed_merged", "completed_candidate_ready", "failed", "blocked_budget", "blocked_quota", "blocked_credentials", "blocked_ci", "blocked_branch_protection", "conflict_blocked", "interrupted"].includes(run.state)) return run;
    this.router.activateDeliveryRun(run.id);
    if (run.integrationPath) return this.#publishPersisted(run, adapters);
    return this.#advance(run, adapters);
  }

  async #publishPersisted(run, adapters) {
    const manifest = this.router.store.integrationManifest(run.integrationPath);
    if (!manifest) return this.router.store.updateDeliveryRun(run.id, { state: "failed", publish: { reason: "Persisted delivery integration manifest is missing", recovery: { action: "Restore the generated integration manifest before resuming." } } });
    const publish = await this.router.publishCandidate({ path: run.integrationPath, manifest }, adapters);
    return this.router.store.updateDeliveryRun(run.id, { state: publish.terminalState, integrationPath: run.integrationPath, publish, confirmRemotePush: this.router.isAutonomous() });
  }

  async #advance(run, context = {}) {
    this.router.activateDeliveryRun(run.id);
    if (!this.router.isAutonomous()) {
      const existingGate = manualGateFor(this.router.list());
      if (existingGate) return this.#awaiting(run, existingGate);
    }
    let execution;
    try { execution = await this.router.runUntilIdle(); }
    catch (error) {
      const current = this.router.store.deliveryRun(run.id);
      if (current?.state === "interrupted") return current;
      return this.router.store.updateDeliveryRun(run.id, { state: "failed", publish: { reason: String(error.message).slice(0, 500), recovery: { action: "Inspect the preserved task worktree and structured task error." } } });
    }
    if (execution?.blockedQuota) return this.router.store.updateDeliveryRun(run.id, { state: "blocked_quota", publish: { reason: execution.quota?.reason ?? "App Server quota policy blocked new turns", quota: execution.quota } });
    if (execution?.interrupted) return this.router.store.deliveryRun(run.id);
    if (execution?.blockedBudget) return this.router.store.deliveryRun(run.id)?.state === "blocked_budget" ? this.router.store.deliveryRun(run.id) : this.router.store.updateDeliveryRun(run.id, { state: "blocked_budget", publish: { reason: "Budget watchdog interrupted an active turn" } });
    const tasks = this.router.list();
    if (!this.router.isAutonomous()) {
      const gate = manualGateFor(tasks);
      if (gate) return this.#awaiting(run, gate);
    }
    const terminalTask = tasks.find((task) => ["failed", "cancelled", "blocked_budget", "interrupted", "awaiting_approval"].includes(task.status));
    if (terminalTask) {
      const terminal = terminalForTask(terminalTask);
      return this.router.store.updateDeliveryRun(run.id, { state: terminal.state, publish: { taskId: terminalTask.id, reason: terminal.reason, recovery: { action: "Inspect the task result/report and preserved worktree, correct the source condition, then start a fresh delivery run." } } });
    }
    const engineering = tasks.filter((task) => ENGINEERING_DOMAINS.has(task.role));
    if (!engineering.length || engineering.some((task) => task.status !== "done")) return this.router.store.updateDeliveryRun(run.id, { state: "failed", publish: { reason: "Delivery stopped without a completed engineering DAG", recovery: { action: "Inspect the persisted scheduler state and task dependencies." } } });
    let integration;
    try { integration = await this.router.runToIntegration({ alreadyIdle: true }); }
    catch (error) { return this.router.store.updateDeliveryRun(run.id, { state: "conflict_blocked", publish: { reason: String(error.message).slice(0, 500), recovery: { action: "Inspect the retained candidate/worktree and verification results." } } }); }
    if (integration.integration.manifest.status !== "candidate_ready") return this.router.store.updateDeliveryRun(run.id, { state: "conflict_blocked", integrationPath: integration.integration.path, publish: { reason: integration.integration.manifest.blockedReason, recovery: integration.integration.manifest.recovery } });
    const publish = await this.router.publishCandidate(integration.integration, context);
    return this.router.store.updateDeliveryRun(run.id, { state: publish.terminalState, integrationPath: integration.integration.path, publish, confirmRemotePush: this.router.isAutonomous() });
  }

  #awaiting(run, gate) {
    const updated = this.router.store.updateDeliveryRun(run.id, { state: "awaiting_human", confirmRemotePush: false });
    return { ...updated, terminalState: "awaiting_human", currentGate: gate };
  }
}
