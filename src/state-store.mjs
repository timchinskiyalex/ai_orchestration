import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assertRole, assertTransition } from "./domain.mjs";

const now = () => new Date().toISOString();
const json = (value) => JSON.stringify(value ?? []);
const parse = (value, fallback) => (value ? JSON.parse(value) : fallback);

export class StateStore {
  constructor(filePath, { readOnly = false } = {}) {
    const isNewDatabase = !existsSync(filePath);
    if (!readOnly) mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath, { readOnly });
    // `status`/`watch` deliberately open old runtime databases read-only.  A
    // pre-migration database must remain observable rather than throwing on a
    // column added by a newer controller.
    this.hasTokenUsageSource = this.#hasColumn("tasks", "token_usage_source");
    if (readOnly) return;
    // Switching journal mode takes an exclusive SQLite lock. Do it once at
    // database creation, never in every short-lived status/watch reader.
    if (isNewDatabase) this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 1000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        parent_task_id TEXT REFERENCES tasks(id),
        role TEXT NOT NULL,
        title TEXT NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL,
        allowed_paths_json TEXT NOT NULL,
        acceptance_checks_json TEXT NOT NULL,
        dependencies_json TEXT NOT NULL DEFAULT '[]',
        human_approval_required INTEGER NOT NULL DEFAULT 0,
        human_approved INTEGER NOT NULL DEFAULT 0,
        worktree TEXT,
        branch TEXT,
        thread_id TEXT,
        turn_id TEXT,
        token_budget INTEGER NOT NULL,
        estimated_tokens INTEGER NOT NULL,
        token_used INTEGER NOT NULL DEFAULT 0,
        token_usage_source TEXT,
        attempt INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        error TEXT,
        result_path TEXT,
        risk_flags_json TEXT NOT NULL DEFAULT '[]',
        supporting_domains_json TEXT NOT NULL DEFAULT '[]',
        artifact_base_sha TEXT,
        artifact_dependencies_json TEXT NOT NULL DEFAULT '[]',
        remediation_round INTEGER NOT NULL DEFAULT 0,
        source_writer_task_id TEXT,
        delivery_run_id TEXT,
        interrupt_threshold_tokens INTEGER,
        configured_budget_cap INTEGER
      );
      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT REFERENCES tasks(id),
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS approvals (
        request_id TEXT PRIMARY KEY,
        task_id TEXT REFERENCES tasks(id),
        method TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        decision TEXT,
        created_at TEXT NOT NULL,
        resolved_at TEXT
      );
      CREATE TABLE IF NOT EXISTS account_snapshots (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        schema_version INTEGER NOT NULL,
        snapshot_json TEXT NOT NULL,
        captured_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS worker_artifacts (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id),
        schema_version INTEGER NOT NULL,
        artifact_path TEXT NOT NULL,
        artifact_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS integration_manifests (
        id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        manifest_path TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS budget_overrides (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id),
        reason TEXT NOT NULL,
        forecast_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS quality_reports (
        qa_task_id TEXT PRIMARY KEY REFERENCES tasks(id),
        writer_task_id TEXT NOT NULL REFERENCES tasks(id),
        schema_version INTEGER NOT NULL,
        report_path TEXT NOT NULL,
        report_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS security_reports (
        security_task_id TEXT PRIMARY KEY REFERENCES tasks(id),
        writer_task_id TEXT NOT NULL REFERENCES tasks(id),
        schema_version INTEGER NOT NULL,
        report_path TEXT NOT NULL,
        report_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS delivery_runs (
        id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        state TEXT NOT NULL,
        source TEXT,
        bootstrap_task_id TEXT REFERENCES tasks(id),
        integration_path TEXT,
        publish_json TEXT,
        confirm_remote_push INTEGER NOT NULL DEFAULT 0,
        owner_pid INTEGER,
        owner_session_id TEXT,
        heartbeat_at TEXT,
        interrupted_at TEXT,
        recovery_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS external_actions (
        idempotency_key TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS budget_interruptions (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id),
        delivery_run_id TEXT,
        thread_id TEXT,
        turn_id TEXT,
        actual_tokens INTEGER NOT NULL,
        interrupt_threshold_tokens INTEGER NOT NULL,
        configured_budget_cap INTEGER NOT NULL,
        threshold_overshoot_tokens INTEGER NOT NULL,
        cap_overshoot_tokens INTEGER NOT NULL,
        reason TEXT NOT NULL,
        interrupted_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_tasks_thread ON tasks(thread_id);
      CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id, sequence);
    `);
    this.#addColumnIfMissing("tasks", "dependencies_json", "TEXT NOT NULL DEFAULT '[]'");
    this.#addColumnIfMissing("tasks", "result_path", "TEXT");
    this.#addColumnIfMissing("tasks", "estimated_tokens", "INTEGER NOT NULL DEFAULT 0");
    this.#addColumnIfMissing("tasks", "human_approval_required", "INTEGER NOT NULL DEFAULT 0");
    this.#addColumnIfMissing("tasks", "human_approved", "INTEGER NOT NULL DEFAULT 0");
    this.#addColumnIfMissing("tasks", "risk_flags_json", "TEXT NOT NULL DEFAULT '[]'");
    this.#addColumnIfMissing("tasks", "supporting_domains_json", "TEXT NOT NULL DEFAULT '[]'");
    this.#addColumnIfMissing("tasks", "artifact_base_sha", "TEXT");
    this.#addColumnIfMissing("tasks", "artifact_dependencies_json", "TEXT NOT NULL DEFAULT '[]'");
    this.#addColumnIfMissing("tasks", "remediation_round", "INTEGER NOT NULL DEFAULT 0");
    this.#addColumnIfMissing("tasks", "source_writer_task_id", "TEXT");
    this.#addColumnIfMissing("tasks", "delivery_run_id", "TEXT");
    this.#addColumnIfMissing("tasks", "interrupt_threshold_tokens", "INTEGER");
    this.#addColumnIfMissing("tasks", "configured_budget_cap", "INTEGER");
    this.#addColumnIfMissing("tasks", "token_usage_source", "TEXT");
    this.hasTokenUsageSource = true;
    this.#addColumnIfMissing("delivery_runs", "owner_pid", "INTEGER");
    this.#addColumnIfMissing("delivery_runs", "owner_session_id", "TEXT");
    this.#addColumnIfMissing("delivery_runs", "heartbeat_at", "TEXT");
    this.#addColumnIfMissing("delivery_runs", "interrupted_at", "TEXT");
    this.#addColumnIfMissing("delivery_runs", "recovery_json", "TEXT");
  }

  close() { this.db.close(); }

  createTask(task) {
    assertRole(task.role);
    const timestamp = now();
    const initialStatus = task.humanApprovalRequired ? "awaiting_human" : "queued";
    this.#mutate(task.id, `task/${initialStatus}`, { role: task.role, title: task.title, humanApprovalRequired: Boolean(task.humanApprovalRequired) }, () => this.db.prepare(`INSERT INTO tasks (
      id, parent_task_id, role, title, prompt, status, allowed_paths_json,
      acceptance_checks_json, dependencies_json, human_approval_required, token_budget, estimated_tokens, max_attempts, created_at, updated_at,
      risk_flags_json, supporting_domains_json, artifact_base_sha, artifact_dependencies_json, remediation_round, source_writer_task_id, delivery_run_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      task.id, task.parentTaskId ?? null, task.role, task.title, task.prompt,
      initialStatus, json(task.allowedPaths), json(task.acceptanceChecks), json(task.dependencies), task.humanApprovalRequired ? 1 : 0, task.tokenBudget, task.estimatedTokens ?? task.tokenBudget,
      task.maxAttempts, timestamp, timestamp, json(task.riskFlags), json(task.supportingDomains), task.artifactBaseSha ?? null,
      json(task.artifactDependencies), task.remediationRound ?? 0, task.sourceWriterTaskId ?? null, task.deliveryRunId ?? null
    ));
    return this.getTask(task.id);
  }

  // Materialized plans are a single controller decision: persist every task
  // and its append-only creation event, or persist none of them.
  createTasks(tasks) {
    if (!Array.isArray(tasks) || !tasks.length) throw new Error("createTasks requires at least one task");
    const ids = new Set();
    for (const task of tasks) {
      assertRole(task.role);
      if (!task.id || ids.has(task.id) || this.getTask(task.id)) throw new Error("Batch task ids must be unique and unused");
      ids.add(task.id);
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const task of tasks) {
        const timestamp = now();
        const initialStatus = task.humanApprovalRequired ? "awaiting_human" : "queued";
        this.db.prepare(`INSERT INTO tasks (
          id, parent_task_id, role, title, prompt, status, allowed_paths_json,
          acceptance_checks_json, dependencies_json, human_approval_required, token_budget, estimated_tokens, max_attempts, created_at, updated_at,
          risk_flags_json, supporting_domains_json, artifact_base_sha, artifact_dependencies_json, remediation_round, source_writer_task_id, delivery_run_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)` ).run(
          task.id, task.parentTaskId ?? null, task.role, task.title, task.prompt,
          initialStatus, json(task.allowedPaths), json(task.acceptanceChecks), json(task.dependencies), task.humanApprovalRequired ? 1 : 0,
          task.tokenBudget, task.estimatedTokens ?? task.tokenBudget, task.maxAttempts ?? 1, timestamp, timestamp,
          json(task.riskFlags), json(task.supportingDomains), task.artifactBaseSha ?? null, json(task.artifactDependencies), task.remediationRound ?? 0, task.sourceWriterTaskId ?? null, task.deliveryRunId ?? null
        );
        this.#insertEvent(task.id, `task/${initialStatus}`, { role: task.role, title: task.title, humanApprovalRequired: Boolean(task.humanApprovalRequired) });
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return tasks.map((task) => this.getTask(task.id));
  }

  getTask(id) {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
    return row ? this.#mapTask(row) : null;
  }

  setArtifactLineage(taskId, { artifactBaseSha, artifactDependencies }) {
    if (!this.getTask(taskId)) throw new Error(`Task not found: ${taskId}`);
    this.db.prepare("UPDATE tasks SET artifact_base_sha = ?, artifact_dependencies_json = ?, updated_at = ? WHERE id = ? AND status = 'queued'").run(artifactBaseSha, json(artifactDependencies), now(), taskId);
    return this.getTask(taskId);
  }
  listTasks() {
    return this.db.prepare("SELECT * FROM tasks ORDER BY created_at ASC").all().map((row) => this.#mapTask(row));
  }

  cancelUnfinishedTasks({ reason, deliveryRunId = null } = {}) {
    const cancellable = ["queued", "preparing", "running", "awaiting_approval", "awaiting_review", "awaiting_human", "blocked_budget"];
    const tasks = this.db.prepare(`SELECT * FROM tasks WHERE status IN (${cancellable.map(() => "?").join(", ")})${deliveryRunId ? " AND delivery_run_id = ?" : ""} ORDER BY created_at`).all(...cancellable, ...(deliveryRunId ? [deliveryRunId] : []));
    if (!tasks.length) return [];
    const timestamp = now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const task of tasks) {
        this.db.prepare("UPDATE tasks SET status = 'cancelled', error = ?, updated_at = ? WHERE id = ?").run(reason ?? "cancelled", timestamp, task.id);
        this.#insertEvent(task.id, "task/status", { from: task.status, to: "cancelled", error: reason ?? "cancelled", recovery: "historical task retained; it will not be resumed" });
      }
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return tasks.map((task) => this.getTask(task.id));
  }

  childCount(parentTaskId) {
    return this.db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE parent_task_id = ?").get(parentTaskId).count;
  }

  claimNext() {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const candidates = this.db.prepare("SELECT * FROM tasks WHERE status = 'queued' ORDER BY created_at").all();
      const row = candidates.find((candidate) => parse(candidate.dependencies_json, []).every((id) => this.getTask(id)?.status === "done"));
      if (!row) { this.db.exec("COMMIT"); return null; }
      const timestamp = now();
      this.db.prepare("UPDATE tasks SET status = 'preparing', attempt = attempt + 1, updated_at = ? WHERE id = ? AND status = 'queued'").run(timestamp, row.id);
      this.#insertEvent(row.id, "task/claimed", { attempt: row.attempt + 1 });
      this.db.exec("COMMIT");
      return this.getTask(row.id);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  transition(id, nextStatus, patch = {}) {
    const current = this.getTask(id);
    if (!current) throw new Error(`Task not found: ${id}`);
    if (current.status === nextStatus) return current;
    assertTransition(current.status, nextStatus);
    const fields = ["status = ?", "updated_at = ?"];
    const values = [nextStatus, now()];
    for (const [column, value] of Object.entries({
      worktree: patch.worktree,
      branch: patch.branch,
      thread_id: patch.threadId,
      turn_id: patch.turnId,
      error: patch.error,
      human_approved: patch.humanApproved === undefined ? undefined : (patch.humanApproved ? 1 : 0)
    })) {
      if (value !== undefined) { fields.push(`${column} = ?`); values.push(value); }
    }
    values.push(id);
    this.#mutate(id, "task/status", { from: current.status, to: nextStatus, ...patch }, () => this.db.prepare(`UPDATE tasks SET ${fields.join(", ")} WHERE id = ?`).run(...values));
    return this.getTask(id);
  }

  setThread(taskId, { threadId, turnId }) {
    this.#mutate(taskId, "thread/linked", { threadId, turnId }, () => this.db.prepare("UPDATE tasks SET thread_id = ?, turn_id = ?, updated_at = ? WHERE id = ?").run(threadId, turnId ?? null, now(), taskId));
  }

  setTokenUsage(taskId, tokenUsed, { source = "turn_last" } = {}) {
    const current = this.getTask(taskId);
    const measured = Math.max(current?.tokenUsed ?? 0, Number(tokenUsed) || 0);
    this.#mutate(taskId, "thread/tokenUsage", { tokenUsed: measured, source }, () => this.db.prepare("UPDATE tasks SET token_used = ?, token_usage_source = ?, updated_at = ? WHERE id = ?").run(measured, source, now(), taskId));
  }

  setRuntimeBudget(taskId, { interruptThresholdTokens, configuredBudgetCap }) {
    this.#mutate(taskId, "budget/runtime-configured", { interruptThresholdTokens, configuredBudgetCap }, () => this.db.prepare("UPDATE tasks SET interrupt_threshold_tokens = ?, configured_budget_cap = ?, updated_at = ? WHERE id = ?").run(interruptThresholdTokens, configuredBudgetCap, now(), taskId));
  }

  linkTaskToDelivery(taskId, deliveryRunId) {
    this.#mutate(taskId, "delivery/task-linked", { deliveryRunId }, () => this.db.prepare("UPDATE tasks SET delivery_run_id = ?, updated_at = ? WHERE id = ?").run(deliveryRunId, now(), taskId));
    return this.getTask(taskId);
  }

  recordBudgetInterruption({ taskId, deliveryRunId = null, threadId, turnId, actualTokens, interruptThresholdTokens, configuredBudgetCap, reason = "budget_interrupt" }) {
    const interruptedAt = now();
    const thresholdOvershootTokens = Math.max(0, actualTokens - interruptThresholdTokens);
    const capOvershootTokens = Math.max(0, actualTokens - configuredBudgetCap);
    const payload = { taskId, deliveryRunId, threadId, turnId, actualTokens, interruptThresholdTokens, configuredBudgetCap, thresholdOvershootTokens, capOvershootTokens, reason, interruptedAt };
    this.#mutate(taskId, "budget/interrupt", payload, () => this.db.prepare(`INSERT OR IGNORE INTO budget_interruptions(
      task_id, delivery_run_id, thread_id, turn_id, actual_tokens, interrupt_threshold_tokens, configured_budget_cap, threshold_overshoot_tokens, cap_overshoot_tokens, reason, interrupted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(taskId, deliveryRunId, threadId, turnId, actualTokens, interruptThresholdTokens, configuredBudgetCap, thresholdOvershootTokens, capOvershootTokens, reason, interruptedAt));
    return this.budgetInterruption(taskId);
  }

  budgetInterruption(taskId) {
    const row = this.db.prepare("SELECT * FROM budget_interruptions WHERE task_id = ?").get(taskId);
    return row ? { taskId: row.task_id, deliveryRunId: row.delivery_run_id, threadId: row.thread_id, turnId: row.turn_id, actualTokens: row.actual_tokens, interruptThresholdTokens: row.interrupt_threshold_tokens, configuredBudgetCap: row.configured_budget_cap, thresholdOvershootTokens: row.threshold_overshoot_tokens, capOvershootTokens: row.cap_overshoot_tokens, reason: row.reason, interruptedAt: row.interrupted_at } : null;
  }

  setResultPath(taskId, resultPath) {
    this.#mutate(taskId, "task/result", { resultPath }, () => this.db.prepare("UPDATE tasks SET result_path = ?, updated_at = ? WHERE id = ?").run(resultPath, now(), taskId));
  }

  usageForRoot(rootTaskId) {
    return this.db.prepare(`WITH RECURSIVE family(id) AS (
      SELECT id FROM tasks WHERE id = ?
      UNION ALL SELECT t.id FROM tasks t JOIN family f ON t.parent_task_id = f.id
    ) SELECT COALESCE(SUM(${this.#measuredUsageSql()}), 0) AS used,
      COALESCE(SUM(CASE WHEN status IN ('queued','preparing','running','awaiting_approval') THEN token_budget ELSE 0 END), 0) AS reserved
      FROM tasks WHERE id IN family`).get(rootTaskId);
  }

  weeklyUsageSince(since) {
    return this.db.prepare(`SELECT
      COALESCE(SUM(${this.#measuredUsageSql()}), 0) AS used,
      COALESCE(SUM(estimated_tokens), 0) AS estimate,
      COALESCE(SUM(CASE WHEN status IN ('queued','preparing','running','awaiting_approval','awaiting_human') THEN token_budget ELSE 0 END), 0) AS reserved
      FROM tasks WHERE created_at >= ?`).get(since);
  }

  usageForDeliveryRun(deliveryRunId) {
    return this.db.prepare(`SELECT COALESCE(SUM(${this.#measuredUsageSql()}), 0) AS used,
      COALESCE(SUM(CASE WHEN status IN ('queued','preparing','running','awaiting_approval','awaiting_human') THEN token_budget ELSE 0 END), 0) AS reserved
      FROM tasks WHERE delivery_run_id = ?`).get(deliveryRunId);
  }

  recordEvent(taskId, type, payload) {
    this.db.exec("BEGIN IMMEDIATE");
    try { this.#insertEvent(taskId, type, payload); this.db.exec("COMMIT"); }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  events({ after = 0, limit = 500 } = {}) {
    return this.db.prepare("SELECT sequence, task_id, type, payload_json, created_at FROM events WHERE sequence > ? ORDER BY sequence ASC LIMIT ?").all(after, limit)
      .map((row) => ({ sequence: row.sequence, taskId: row.task_id, type: row.type, payload: parse(row.payload_json, {}), createdAt: row.created_at }));
  }

  recentEvents(limit = 20) {
    return this.db.prepare("SELECT sequence, task_id, type, payload_json, created_at FROM events ORDER BY sequence DESC LIMIT ?").all(limit)
      .reverse().map((row) => ({ sequence: row.sequence, taskId: row.task_id, type: row.type, payload: parse(row.payload_json, {}), createdAt: row.created_at }));
  }

  recordApproval({ requestId, taskId, method, payload, decision = null }) {
    this.#mutate(taskId, "approval/requested", { requestId, method, decision }, () => {
      this.db.prepare(`INSERT OR REPLACE INTO approvals(request_id, task_id, method, payload_json, decision, created_at, resolved_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(String(requestId), taskId, method, JSON.stringify(payload), decision, now(), decision ? now() : null);
    });
  }

  recordAccountSnapshot(snapshot) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO account_snapshots(schema_version, snapshot_json, captured_at) VALUES (?, ?, ?)").run(snapshot.schemaVersion, JSON.stringify(snapshot), snapshot.capturedAt);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  latestAccountSnapshot() {
    const row = this.db.prepare("SELECT snapshot_json FROM account_snapshots ORDER BY sequence DESC LIMIT 1").get();
    return row ? JSON.parse(row.snapshot_json) : null;
  }

  completedTelemetry() {
    return this.db.prepare("SELECT role, estimated_tokens AS estimatedTokens, token_used AS tokenUsed FROM tasks WHERE status = 'done' AND token_used > 0").all();
  }

  recordWorkerArtifact(taskId, artifactPath, artifact) {
    this.#mutate(taskId, "worker/artifact", { artifactPath, schemaVersion: artifact.schemaVersion }, () => this.db.prepare(`INSERT OR REPLACE INTO worker_artifacts(task_id, schema_version, artifact_path, artifact_json, created_at)
      VALUES (?, ?, ?, ?, ?)` ).run(taskId, artifact.schemaVersion, artifactPath, JSON.stringify(artifact), now()));
  }

  workerArtifact(taskId) {
    const row = this.db.prepare("SELECT artifact_json FROM worker_artifacts WHERE task_id = ?").get(taskId);
    return row ? JSON.parse(row.artifact_json) : null;
  }

  workerArtifactRecord(taskId) {
    const row = this.db.prepare("SELECT artifact_path, artifact_json FROM worker_artifacts WHERE task_id = ?").get(taskId);
    return row ? { path: row.artifact_path, artifact: JSON.parse(row.artifact_json) } : null;
  }

  recordQualityReport({ qaTaskId, writerTaskId, reportPath, report }) {
    this.#mutate(qaTaskId, "quality/report", { writerTaskId, reportPath, verdict: report.verdict }, () => this.db.prepare(`INSERT OR REPLACE INTO quality_reports(qa_task_id, writer_task_id, schema_version, report_path, report_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)` ).run(qaTaskId, writerTaskId, report.schemaVersion, reportPath, JSON.stringify(report), now()));
  }

  qualityReport(qaTaskId) {
    const row = this.db.prepare("SELECT report_path, report_json FROM quality_reports WHERE qa_task_id = ?").get(qaTaskId);
    return row ? { path: row.report_path, report: JSON.parse(row.report_json) } : null;
  }

  recordSecurityReport({ securityTaskId, writerTaskId, reportPath, report }) {
    this.#mutate(securityTaskId, "security/report", { writerTaskId, reportPath, verdict: report.verdict }, () => this.db.prepare(`INSERT OR REPLACE INTO security_reports(security_task_id, writer_task_id, schema_version, report_path, report_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)` ).run(securityTaskId, writerTaskId, report.schemaVersion, reportPath, JSON.stringify(report), now()));
  }

  securityReport(securityTaskId) {
    const row = this.db.prepare("SELECT report_path, report_json FROM security_reports WHERE security_task_id = ?").get(securityTaskId);
    return row ? { path: row.report_path, report: JSON.parse(row.report_json) } : null;
  }

  createDeliveryRun({ id, source = null, bootstrapTaskId = null, confirmRemotePush = false, ownerPid, ownerSessionId }) {
    if (!Number.isInteger(ownerPid) || ownerPid < 1 || typeof ownerSessionId !== "string" || !ownerSessionId) throw new Error("Delivery run requires an initial owner lease");
    const timestamp = now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const active = this.db.prepare("SELECT id FROM delivery_runs WHERE state IN ('running','awaiting_human','awaiting_human_remote_handoff') LIMIT 1").get();
      if (active) throw new Error(`Delivery already owned by active run: ${active.id}`);
      this.db.prepare("INSERT INTO delivery_runs(id, schema_version, state, source, bootstrap_task_id, confirm_remote_push, owner_pid, owner_session_id, heartbeat_at, created_at, updated_at) VALUES (?, 1, 'running', ?, ?, ?, ?, ?, ?, ?, ?)").run(id, source, bootstrapTaskId, confirmRemotePush ? 1 : 0, ownerPid, ownerSessionId, timestamp, timestamp, timestamp);
      this.#insertEvent(bootstrapTaskId, "delivery/created", { deliveryRunId: id, confirmRemotePush: Boolean(confirmRemotePush), ownerPid, ownerSessionId, heartbeatAt: timestamp });
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.deliveryRun(id);
  }

  deliveryRun(id) {
    const row = this.db.prepare("SELECT * FROM delivery_runs WHERE id = ?").get(id);
    return row ? this.#mapDeliveryRun(row) : null;
  }

  currentDeliveryRun() {
    const row = this.db.prepare("SELECT * FROM delivery_runs ORDER BY created_at DESC LIMIT 1").get();
    return row ? this.#mapDeliveryRun(row) : null;
  }

  updateDeliveryRun(id, { state, integrationPath, publish, confirmRemotePush } = {}) {
    const current = this.deliveryRun(id); if (!current) throw new Error(`Delivery run not found: ${id}`);
    const next = { state: state ?? current.state, integrationPath: integrationPath ?? current.integrationPath, publish: publish ?? current.publish, confirmRemotePush: confirmRemotePush ?? current.confirmRemotePush };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const terminal = !["running", "awaiting_human", "awaiting_human_remote_handoff"].includes(next.state);
      if (!terminal) {
        const active = this.db.prepare("SELECT id FROM delivery_runs WHERE state IN ('running','awaiting_human','awaiting_human_remote_handoff') AND id != ? LIMIT 1").get(id);
        if (active) throw new Error(`Delivery already owned by active run: ${active.id}`);
      }
      this.db.prepare("UPDATE delivery_runs SET state = ?, integration_path = ?, publish_json = ?, confirm_remote_push = ?, owner_pid = CASE WHEN ? THEN NULL ELSE owner_pid END, owner_session_id = CASE WHEN ? THEN NULL ELSE owner_session_id END, heartbeat_at = CASE WHEN ? THEN NULL ELSE heartbeat_at END, updated_at = ? WHERE id = ?").run(next.state, next.integrationPath, next.publish ? JSON.stringify(next.publish) : null, next.confirmRemotePush ? 1 : 0, terminal ? 1 : 0, terminal ? 1 : 0, terminal ? 1 : 0, now(), id);
      this.#insertEvent(current.bootstrapTaskId, "delivery/state", { deliveryRunId: id, state: next.state, confirmRemotePush: next.confirmRemotePush });
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.deliveryRun(id);
  }

  claimDeliveryLease(id, { ownerPid, ownerSessionId }) {
    const timestamp = now();
    if (!Number.isInteger(ownerPid) || ownerPid < 1 || typeof ownerSessionId !== "string" || !ownerSessionId) throw new Error("Delivery lease requires owner pid and session");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.deliveryRun(id); if (!current) throw new Error(`Delivery run not found: ${id}`);
      if (!["running", "awaiting_human", "awaiting_human_remote_handoff"].includes(current.state)) throw new Error(`Delivery run is terminal: ${id}`);
      if (current.ownerSessionId && current.ownerSessionId !== ownerSessionId) throw new Error(`Delivery already owned: ${id}`);
      this.db.prepare("UPDATE delivery_runs SET owner_pid = ?, owner_session_id = ?, heartbeat_at = ?, updated_at = ? WHERE id = ? AND (owner_session_id IS NULL OR owner_session_id = ?)").run(ownerPid, ownerSessionId, timestamp, timestamp, id, ownerSessionId);
      this.#insertEvent(current.bootstrapTaskId, "delivery/lease-claimed", { deliveryRunId: id, ownerPid, ownerSessionId, heartbeatAt: timestamp });
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.deliveryRun(id);
  }

  heartbeatDeliveryLease(id, ownerSessionId) {
    const timestamp = now();
    const current = this.deliveryRun(id); if (!current || current.ownerSessionId !== ownerSessionId) return null;
    this.db.prepare("UPDATE delivery_runs SET heartbeat_at = ?, updated_at = ? WHERE id = ? AND owner_session_id = ?").run(timestamp, timestamp, id, ownerSessionId);
    return this.deliveryRun(id);
  }

  interruptDeliveryRun(id, { reason, recovery = null } = {}) {
    const current = this.deliveryRun(id); if (!current) throw new Error(`Delivery run not found: ${id}`);
    const timestamp = now();
    const nextRecovery = { ...(current.recovery ?? {}), reason, ...(recovery ?? {}), interruptedAt: timestamp };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE delivery_runs SET state = 'interrupted', interrupted_at = ?, recovery_json = ?, owner_pid = NULL, owner_session_id = NULL, heartbeat_at = NULL, updated_at = ? WHERE id = ?").run(timestamp, JSON.stringify(nextRecovery), timestamp, id);
      const active = this.db.prepare("SELECT id, status, thread_id, turn_id, token_used FROM tasks WHERE (delivery_run_id = ? OR id = ?) AND status IN ('preparing','running','awaiting_approval')").all(id, current.bootstrapTaskId);
      for (const task of active) {
        this.db.prepare("UPDATE tasks SET status = 'interrupted', error = ?, updated_at = ? WHERE id = ?").run(reason, timestamp, task.id);
        this.#insertEvent(task.id, "task/status", { from: task.status, to: "interrupted", error: reason, threadId: task.thread_id, turnId: task.turn_id, tokenUsed: task.token_used });
      }
      this.#insertEvent(current.bootstrapTaskId, "delivery/interrupted", { deliveryRunId: id, reason, recovery: nextRecovery, interruptedTasks: active.map((task) => task.id) });
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.deliveryRun(id);
  }

  recoverStaleDeliveryRuns({ isProcessAlive, staleAfterMs }) {
    const cutoff = Date.now() - staleAfterMs;
    const candidates = this.db.prepare("SELECT * FROM delivery_runs WHERE state IN ('running','awaiting_human','awaiting_human_remote_handoff') ORDER BY created_at ASC").all();
    const recovered = [];
    for (const row of candidates) {
      const run = this.#mapDeliveryRun(row);
      const heartbeat = run.heartbeatAt ? Date.parse(run.heartbeatAt) : 0;
      const ownerAlive = Number.isInteger(run.ownerPid) && isProcessAlive(run.ownerPid);
      if (ownerAlive && heartbeat > cutoff) continue;
      const reason = !run.ownerPid ? "interrupted_controller_exit: missing owner lease" : ownerAlive ? "interrupted_controller_exit: stale owner heartbeat" : "interrupted_controller_exit: owner process is not alive";
      recovered.push(this.interruptDeliveryRun(run.id, { reason, recovery: { previousOwnerPid: run.ownerPid, previousOwnerSessionId: run.ownerSessionId, previousHeartbeatAt: run.heartbeatAt, staleAfterMs } }));
    }
    return recovered;
  }

  recordExternalAction({ idempotencyKey, kind, status, payload = {} }) {
    const existing = this.db.prepare("SELECT payload_json, status FROM external_actions WHERE idempotency_key = ?").get(idempotencyKey);
    if (existing) return { duplicate: true, status: existing.status, payload: JSON.parse(existing.payload_json) };
    const timestamp = now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO external_actions(idempotency_key, kind, status, payload_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(idempotencyKey, kind, status, JSON.stringify(payload), timestamp, timestamp);
      this.#insertEvent(null, "external/action", { kind, status, idempotencyKey });
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return { duplicate: false, status, payload };
  }

  externalAction(idempotencyKey) {
    const row = this.db.prepare("SELECT kind, status, payload_json, created_at, updated_at FROM external_actions WHERE idempotency_key = ?").get(idempotencyKey);
    return row ? { kind: row.kind, status: row.status, payload: JSON.parse(row.payload_json), createdAt: row.created_at, updatedAt: row.updated_at } : null;
  }

  updateExternalAction(idempotencyKey, { status, payload }) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE external_actions SET status = ?, payload_json = ?, updated_at = ? WHERE idempotency_key = ?").run(status, JSON.stringify(payload ?? {}), now(), idempotencyKey);
      this.#insertEvent(null, "external/action", { idempotencyKey, status });
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.externalAction(idempotencyKey);
  }

  recordIntegrationManifest(manifestPath, manifest) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT OR REPLACE INTO integration_manifests(id, schema_version, manifest_path, manifest_json, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(manifest.id, manifest.schemaVersion, manifestPath, JSON.stringify(manifest), now());
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  integrationManifest(manifestPath) {
    const row = this.db.prepare("SELECT manifest_json FROM integration_manifests WHERE manifest_path = ?").get(manifestPath);
    return row ? JSON.parse(row.manifest_json) : null;
  }

  recordBudgetOverride({ taskId, reason, forecast }) {
    this.#mutate(taskId, "budget/override", { reason, forecast }, () => this.db.prepare(`INSERT OR REPLACE INTO budget_overrides(task_id, reason, forecast_json, created_at)
      VALUES (?, ?, ?, ?)`).run(taskId, reason, JSON.stringify(forecast), now()));
  }

  budgetOverride(taskId) {
    const row = this.db.prepare("SELECT reason, forecast_json, created_at FROM budget_overrides WHERE task_id = ?").get(taskId);
    return row ? { reason: row.reason, forecast: JSON.parse(row.forecast_json), createdAt: row.created_at } : null;
  }

  #mapTask(row) {
    return {
      id: row.id, parentTaskId: row.parent_task_id, role: row.role, title: row.title,
      prompt: row.prompt, status: row.status, allowedPaths: parse(row.allowed_paths_json, []), humanApprovalRequired: Boolean(row.human_approval_required), humanApproved: Boolean(row.human_approved),
      acceptanceChecks: parse(row.acceptance_checks_json, []), dependencies: parse(row.dependencies_json, []), worktree: row.worktree,
      branch: row.branch, threadId: row.thread_id, turnId: row.turn_id,
      tokenBudget: row.token_budget, tokenUsed: row.token_used, tokenUsageSource: row.token_usage_source, attempt: row.attempt,
      estimatedTokens: row.estimated_tokens,
      maxAttempts: row.max_attempts, createdAt: row.created_at, updatedAt: row.updated_at,
      error: row.error, resultPath: row.result_path,
      riskFlags: parse(row.risk_flags_json, []), supportingDomains: parse(row.supporting_domains_json, []),
      artifactBaseSha: row.artifact_base_sha, artifactDependencies: parse(row.artifact_dependencies_json, []),
      remediationRound: row.remediation_round, sourceWriterTaskId: row.source_writer_task_id,
      deliveryRunId: row.delivery_run_id, interruptThresholdTokens: row.interrupt_threshold_tokens, configuredBudgetCap: row.configured_budget_cap,
      budgetInterrupt: this.budgetInterruption(row.id)
    };
  }

  #mapDeliveryRun(row) {
    return { id: row.id, schemaVersion: row.schema_version, state: row.state, source: row.source, bootstrapTaskId: row.bootstrap_task_id, integrationPath: row.integration_path, publish: parse(row.publish_json, null), confirmRemotePush: Boolean(row.confirm_remote_push), ownerPid: row.owner_pid, ownerSessionId: row.owner_session_id, heartbeatAt: row.heartbeat_at, interruptedAt: row.interrupted_at, recovery: parse(row.recovery_json, null), createdAt: row.created_at, updatedAt: row.updated_at };
  }

  #addColumnIfMissing(table, column, definition) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some((item) => item.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  #hasColumn(table, column) {
    try { return this.db.prepare(`PRAGMA table_info(${table})`).all().some((item) => item.name === column); }
    catch { return false; }
  }

  #measuredUsageSql() {
    return this.hasTokenUsageSource ? "CASE WHEN token_usage_source = 'turn_last' THEN token_used ELSE 0 END" : "0";
  }

  #insertEvent(taskId, type, payload) {
    this.db.prepare("INSERT INTO events(task_id, type, payload_json, created_at) VALUES (?, ?, ?, ?)").run(taskId, type, JSON.stringify(payload ?? {}), now());
  }

  #mutate(taskId, type, payload, operation) {
    this.db.exec("BEGIN IMMEDIATE");
    try { operation(); this.#insertEvent(taskId, type, payload); this.db.exec("COMMIT"); }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
}
