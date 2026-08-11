import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assertRole, assertTransition } from "./domain.mjs";

const now = () => new Date().toISOString();
const json = (value) => JSON.stringify(value ?? []);
const parse = (value, fallback) => (value ? JSON.parse(value) : fallback);

export class StateStore {
  constructor(filePath) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
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
        attempt INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        error TEXT,
        result_path TEXT
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
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_tasks_thread ON tasks(thread_id);
      CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id, sequence);
    `);
    this.#addColumnIfMissing("tasks", "dependencies_json", "TEXT NOT NULL DEFAULT '[]'");
    this.#addColumnIfMissing("tasks", "result_path", "TEXT");
    this.#addColumnIfMissing("tasks", "estimated_tokens", "INTEGER NOT NULL DEFAULT 0");
    this.#addColumnIfMissing("tasks", "human_approval_required", "INTEGER NOT NULL DEFAULT 0");
    this.#addColumnIfMissing("tasks", "human_approved", "INTEGER NOT NULL DEFAULT 0");
  }

  close() { this.db.close(); }

  createTask(task) {
    assertRole(task.role);
    const timestamp = now();
    const initialStatus = task.humanApprovalRequired ? "awaiting_human" : "queued";
    this.#mutate(task.id, `task/${initialStatus}`, { role: task.role, title: task.title, humanApprovalRequired: Boolean(task.humanApprovalRequired) }, () => this.db.prepare(`INSERT INTO tasks (
      id, parent_task_id, role, title, prompt, status, allowed_paths_json,
      acceptance_checks_json, dependencies_json, human_approval_required, token_budget, estimated_tokens, max_attempts, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      task.id, task.parentTaskId ?? null, task.role, task.title, task.prompt,
      initialStatus, json(task.allowedPaths), json(task.acceptanceChecks), json(task.dependencies), task.humanApprovalRequired ? 1 : 0, task.tokenBudget, task.estimatedTokens ?? task.tokenBudget,
      task.maxAttempts, timestamp, timestamp
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
          acceptance_checks_json, dependencies_json, human_approval_required, token_budget, estimated_tokens, max_attempts, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)` ).run(
          task.id, task.parentTaskId ?? null, task.role, task.title, task.prompt,
          initialStatus, json(task.allowedPaths), json(task.acceptanceChecks), json(task.dependencies), task.humanApprovalRequired ? 1 : 0,
          task.tokenBudget, task.estimatedTokens ?? task.tokenBudget, task.maxAttempts ?? 1, timestamp, timestamp
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

  listTasks() {
    return this.db.prepare("SELECT * FROM tasks ORDER BY created_at ASC").all().map((row) => this.#mapTask(row));
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

  setTokenUsage(taskId, tokenUsed) {
    this.#mutate(taskId, "thread/tokenUsage", { tokenUsed }, () => this.db.prepare("UPDATE tasks SET token_used = ?, updated_at = ? WHERE id = ?").run(tokenUsed, now(), taskId));
  }

  setResultPath(taskId, resultPath) {
    this.#mutate(taskId, "task/result", { resultPath }, () => this.db.prepare("UPDATE tasks SET result_path = ?, updated_at = ? WHERE id = ?").run(resultPath, now(), taskId));
  }

  usageForRoot(rootTaskId) {
    return this.db.prepare(`WITH RECURSIVE family(id) AS (
      SELECT id FROM tasks WHERE id = ?
      UNION ALL SELECT t.id FROM tasks t JOIN family f ON t.parent_task_id = f.id
    ) SELECT COALESCE(SUM(token_used), 0) AS used,
      COALESCE(SUM(CASE WHEN status IN ('queued','preparing','running','awaiting_approval') THEN token_budget ELSE 0 END), 0) AS reserved
      FROM tasks WHERE id IN family`).get(rootTaskId);
  }

  weeklyUsageSince(since) {
    return this.db.prepare(`SELECT
      COALESCE(SUM(token_used), 0) AS used,
      COALESCE(SUM(estimated_tokens), 0) AS estimate,
      COALESCE(SUM(CASE WHEN status IN ('queued','preparing','running','awaiting_approval','awaiting_human') THEN token_budget ELSE 0 END), 0) AS reserved
      FROM tasks WHERE created_at >= ?`).get(since);
  }

  recordEvent(taskId, type, payload) {
    this.#insertEvent(taskId, type, payload);
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

  recordIntegrationManifest(manifestPath, manifest) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT OR REPLACE INTO integration_manifests(id, schema_version, manifest_path, manifest_json, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(manifest.id, manifest.schemaVersion, manifestPath, JSON.stringify(manifest), now());
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
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
      tokenBudget: row.token_budget, tokenUsed: row.token_used, attempt: row.attempt,
      estimatedTokens: row.estimated_tokens,
      maxAttempts: row.max_attempts, createdAt: row.created_at, updatedAt: row.updated_at,
      error: row.error, resultPath: row.result_path
    };
  }

  #addColumnIfMissing(table, column, definition) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some((item) => item.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
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
