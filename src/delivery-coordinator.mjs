import { randomUUID } from "node:crypto";
import { ingestDocumentation } from "./project-intake.mjs";
import { ENGINEERING_DOMAINS } from "./domain.mjs";

function gateFor(tasks) {
  const task = tasks.find((item) => ["awaiting_human", "awaiting_approval", "blocked_budget"].includes(item.status));
  if (!task) return null;
  const reason = task.error ?? (task.status === "blocked_budget" ? "Local budget policy blocks execution" : "Explicit human approval is required");
  return { taskId: task.id, status: task.status, reason, approveCommand: task.status === "blocked_budget" ? `npm run status -- --json` : `npm run approve -- --task ${task.id}`, resumeCommand: "npm run deliver -- --resume" };
}

export class DeliveryCoordinator {
  constructor(router) { this.router = router; }

  async begin({ source, confirmRemotePush = false }) {
    const current = this.router.store.currentDeliveryRun();
    if (current && ["running", "awaiting_human", "awaiting_human_remote_handoff"].includes(current.state)) throw new Error(`A delivery run is already active: ${current.id}. Use npm run deliver -- --resume.`);
    const intake = ingestDocumentation({ source, repository: this.router.config.repository, destinationRelative: this.router.config.project.documentationDir });
    const overlay = await this.router.ensureProjectOverlay();
    const bootstrap = this.router.startProject();
    const run = this.router.store.createDeliveryRun({ id: randomUUID(), source, bootstrapTaskId: bootstrap.id, confirmRemotePush });
    return this.#advance(run, { intake, overlayPath: overlay.path, confirmRemotePush });
  }

  async resume({ confirmRemotePush = false, remoteGitAdapter = null, remoteCiAdapter = null } = {}) {
    const run = this.router.store.currentDeliveryRun();
    if (!run) throw new Error("No delivery run exists; start with npm run deliver -- --source <docs-dir>");
    if (run.state === "completed_candidate_ready") return run;
    if (["failed", "conflict_blocked"].includes(run.state)) return run;
    const updated = confirmRemotePush && !run.confirmRemotePush ? this.router.store.updateDeliveryRun(run.id, { confirmRemotePush: true, state: "running" }) : run;
    if (updated.integrationPath && updated.publish?.status === "awaiting_human_remote_handoff") {
      const manifest = this.router.store.integrationManifest(updated.integrationPath);
      if (!manifest) throw new Error("Persisted delivery integration manifest is missing");
      const publish = await this.router.publishCandidate({ path: updated.integrationPath, manifest }, { confirmRemotePush: updated.confirmRemotePush, remoteGitAdapter, remoteCiAdapter });
      return this.router.store.updateDeliveryRun(updated.id, { state: publish.terminalState, integrationPath: updated.integrationPath, publish, confirmRemotePush: updated.confirmRemotePush });
    }
    return this.#advance(updated, { confirmRemotePush: updated.confirmRemotePush, remoteGitAdapter, remoteCiAdapter });
  }

  async #advance(run, context = {}) {
    let gate = gateFor(this.router.list());
    if (gate) return this.#awaiting(run, gate, context);
    try { await this.router.runUntilIdle(); }
    catch (error) { return this.router.store.updateDeliveryRun(run.id, { state: "failed", publish: { reason: String(error.message).slice(0, 500) } }); }
    const tasks = this.router.list();
    gate = gateFor(tasks);
    if (gate) return this.#awaiting(run, gate, context);
    const failed = tasks.find((task) => ["failed", "cancelled"].includes(task.status));
    if (failed) return this.router.store.updateDeliveryRun(run.id, { state: "failed", publish: { taskId: failed.id, reason: failed.error ?? failed.status } });
    const engineering = tasks.filter((task) => ENGINEERING_DOMAINS.has(task.role));
    if (!engineering.length || engineering.some((task) => task.status !== "done")) return this.router.store.updateDeliveryRun(run.id, { state: "failed", publish: { reason: "Delivery stopped without a valid gate or completed engineering DAG" } });
    const security = engineering.filter((task) => task.role === "security" && task.sourceWriterTaskId);
    const quality = engineering.filter((task) => task.role === "qa" && task.sourceWriterTaskId);
    if (security.some((task) => this.router.store.securityReport(task.id)?.report.verdict !== "pass") || quality.some((task) => this.router.store.qualityReport(task.id)?.report.verdict !== "pass")) {
      return this.router.store.updateDeliveryRun(run.id, { state: "awaiting_human", publish: { reason: "Required Security or QA gate is not passed" } });
    }
    const integration = await this.router.runToIntegration({ alreadyIdle: true });
    if (integration.integration.manifest.status !== "awaiting_human_merge") return this.router.store.updateDeliveryRun(run.id, { state: "conflict_blocked", integrationPath: integration.integration.path, publish: { reason: integration.integration.manifest.blockedReason } });
    const publish = await this.router.publishCandidate(integration.integration, { confirmRemotePush: Boolean(context.confirmRemotePush), remoteGitAdapter: context.remoteGitAdapter, remoteCiAdapter: context.remoteCiAdapter });
    return this.router.store.updateDeliveryRun(run.id, { state: publish.terminalState, integrationPath: integration.integration.path, publish, confirmRemotePush: Boolean(context.confirmRemotePush) });
  }

  #awaiting(run, gate, context) {
    const updated = this.router.store.updateDeliveryRun(run.id, { state: "awaiting_human", confirmRemotePush: Boolean(context.confirmRemotePush) });
    return { ...updated, terminalState: "awaiting_human", currentGate: gate };
  }
}
