import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { resolve, relative, sep, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const toPosix = (value) => value.replace(/\\/g, "/");
const token = () => randomUUID().replace(/-/g, "");
const within = (root, target) => { const rel = relative(root, target); return Boolean(rel) && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };
const cleanStatus = async (cwd) => !(await exec("git", ["-C", cwd, "status", "--porcelain=v1", "-z", "--untracked-files=all"], { encoding: "buffer" })).stdout.length;
const git = async (cwd, args) => (await exec("git", ["-C", cwd, ...args])).stdout.trim();

// Git's porcelain worktree output is NUL-delimited.  Do not use line parsing:
// valid paths can contain spaces, tabs, Unicode, and newlines.
export function parseWorktreePorcelainZ(buffer) {
  const fields = Buffer.isBuffer(buffer) ? buffer.toString("utf8").split("\0") : String(buffer).split("\0");
  const records = []; let current = null;
  for (const field of fields) {
    if (!field) { if (current?.path) records.push(current); current = null; continue; }
    const space = field.indexOf(" "); const key = space < 0 ? field : field.slice(0, space); const value = space < 0 ? "" : field.slice(space + 1);
    if (key === "worktree") { if (current?.path) records.push(current); current = { path: value, head: null, branch: null, bare: false }; }
    else if (current && key === "HEAD") current.head = value;
    else if (current && key === "branch") current.branch = value.startsWith("refs/heads/") ? value.slice("refs/heads/".length) : value;
    else if (current && key === "bare") current.bare = true;
  }
  if (current?.path) records.push(current);
  return records;
}

export class WorktreeManager {
  constructor({ repository, runtimeDir, baseRef, project = {}, store = null, readOnly = false }) {
    this.repository = resolve(repository);
    this.runtimeDir = resolve(runtimeDir);
    this.root = resolve(runtimeDir, "worktrees");
    this.integrationRoot = resolve(runtimeDir, "integrations");
    this.baseRef = baseRef;
    this.store = store;
    this.project = project;
    this.readOnly = readOnly;
    // Legacy direct manager users are execution-capable. Read-only router
    // construction deliberately passes readOnly and never touches runtime.
    if (!readOnly) mkdirSync(this.root, { recursive: true });
  }

  async repositoryIdentity() {
    const root = realpathSync(this.repository);
    const common = await git(root, ["rev-parse", "--git-common-dir"]);
    return { repositoryRoot: root, repositoryCommonDir: realpathSync(resolve(root, common)) };
  }

  async registeredWorktrees() {
    const { stdout } = await exec("git", ["-C", this.repository, "worktree", "list", "--porcelain", "-z"], { encoding: "buffer", maxBuffer: 2_000_000 });
    return parseWorktreePorcelainZ(stdout).map((item) => ({ ...item, canonicalPath: existsSync(item.path) ? realpathSync(item.path) : null }));
  }

  async verifyRepository() {
    const inside = await git(this.repository, ["rev-parse", "--is-inside-work-tree"]);
    if (inside !== "true") throw new Error(`${this.repository} is not a Git worktree`);
    const status = await exec("git", ["-C", this.repository, "status", "--porcelain=v1", "-z", "--untracked-files=all"], { encoding: "buffer" });
    const prefixes = [this.project.documentationDir, this.project.generatedDir].filter(Boolean).map((value) => `${toPosix(value).replace(/\/$/, "")}/`);
    if (within(this.repository, this.runtimeDir)) prefixes.push(`${toPosix(relative(this.repository, this.runtimeDir)).replace(/\/$/, "")}/`);
    const fields = status.stdout.toString("utf8").split("\0"); const unsafe = [];
    for (let index = 0; index < fields.length; index += 1) {
      const field = fields[index]; if (!field) continue;
      if (field.length < 4 || field[2] !== " ") throw new Error("Unexpected Git porcelain v1 -z record");
      const state = field.slice(0, 2); const paths = [field.slice(3)]; if (state.includes("R") || state.includes("C")) paths.push(fields[++index] ?? "");
      unsafe.push(...paths.filter((path) => !prefixes.some((prefix) => toPosix(path).startsWith(prefix))).map(toPosix));
    }
    if (unsafe.length) throw new Error(`Target repository has uncommitted code changes; refuse to create swarm worktrees: ${unsafe.join(", ")}`);
  }

  #location(kind, readable, recordId) {
    const root = kind === "worker" ? this.root : this.integrationRoot;
    // The label is diagnostic only; the opaque id makes Unicode and old
    // safePart collisions impossible to turn into an ownership collision.
    return join(root, `${kind}-${recordId.slice(0, 16)}`);
  }

  async createManaged({ kind = "worker", taskId = null, deliveryRunId = null, planBatchId = null, barrierId = null, candidateId = null, baseSha = this.baseRef, attempt = 1, sessionId = randomUUID() } = {}) {
    if (!this.store) throw new Error("Managed worktree creation requires StateStore ownership");
    const sameController = this.store.listManagedWorktrees().filter((record) => record.kind === kind && ((kind === "integration_barrier" && record.barrierId === barrierId) || (kind === "candidate_integration" && record.candidateId === candidateId)));
    if (sameController.length) {
      // An integration reference has one durable owner. A retry must reconcile
      // that owner or enter scoped recovery; it may never create a competing
      // integration worktree merely because a previous process crashed.
      const existing = sameController[0]; const checked = await this.verifyRecord(existing.recordId);
      this.store.updateManagedWorktree(existing.recordId, { phase: checked.ok ? existing.phase : "preserved", classification: checked.ok ? existing.classification : checked.classification, verification: checked.safe });
      throw new Error(`Managed ${kind} already has durable ownership record ${existing.recordId}; inspect preserved recovery state before retrying`);
    }
    if (!/^[a-f0-9]{40}$/i.test(baseSha ?? "")) baseSha = await git(this.repository, ["rev-parse", "--verify", `${baseSha}^{commit}`]);
    const recordId = randomUUID(); const identity = await this.repositoryIdentity();
    const intendedPath = this.#location(kind, taskId ?? barrierId ?? candidateId ?? "managed", recordId);
    const branch = `swarm/v2/${kind}/${token()}`;
    const intent = this.store.recordManagedWorktreeIntent({ recordId, kind, ...identity, intendedPath, taskId, deliveryRunId, planBatchId, barrierId, candidateId, branch, intendedBaseSha: baseSha, creationSessionId: sessionId ?? randomUUID(), attempt, ownerVersion: "managed-worktree/v2" });
    // Only after the durable intent exists may Git create a directory.
    mkdirSync(kind === "worker" ? this.root : this.integrationRoot, { recursive: true });
    await exec("git", ["-C", this.repository, "worktree", "add", "-b", branch, intendedPath, baseSha]);
    this.store.updateManagedWorktree(recordId, { phase: "git_created" });
    const verified = await this.verifyRecord(intent.recordId);
    if (!verified.ok) { this.store.updateManagedWorktree(recordId, { phase: "preserved", classification: verified.classification, verification: verified.safe }); throw new Error(`Managed worktree integrity blocked: ${verified.classification}`); }
    return this.store.linkManagedWorktree(recordId, { canonicalPath: verified.canonicalPath, lastVerifiedHead: verified.head, verification: verified.safe, taskId });
  }

  async create(taskId, { baseSha = this.baseRef, task = null, sessionId = undefined } = {}) {
    const record = await this.createManaged({ kind: "worker", taskId, deliveryRunId: task?.deliveryRunId ?? null, planBatchId: task?.planBatchId ?? null, baseSha, attempt: task?.attempt ?? 1, sessionId });
    return { worktree: record.canonicalPath, branch: record.branch, recordId: record.recordId };
  }

  async verifyRecord(recordId) {
    const record = this.store?.managedWorktree(recordId); if (!record) return { ok: false, classification: "foreign", safe: { reason: "missing durable record" } };
    try {
      const identity = await this.repositoryIdentity();
      if (identity.repositoryRoot !== record.repositoryRoot || identity.repositoryCommonDir !== record.repositoryCommonDir) return { ok: false, classification: "integrity-blocked", safe: { reason: "repository identity mismatch" } };
      if (!existsSync(record.intendedPath)) return { ok: false, classification: "missing", safe: { reason: "path missing" } };
      const canonicalPath = realpathSync(record.intendedPath);
      const allowedRoot = record.kind === "worker" ? this.root : this.integrationRoot;
      if (!existsSync(allowedRoot) || !within(realpathSync(allowedRoot), canonicalPath)) return { ok: false, classification: "integrity-blocked", safe: { reason: "path escapes managed runtime" } };
      const duplicate = this.store.listManagedWorktrees().find((other) => other.recordId !== record.recordId && (other.canonicalPath === canonicalPath || other.intendedPath === record.intendedPath));
      if (duplicate) return { ok: false, classification: "integrity-blocked", safe: { reason: "duplicate managed canonical path" } };
      const inventory = await this.registeredWorktrees(); const matches = inventory.filter((item) => item.canonicalPath === canonicalPath);
      if (matches.length !== 1) return { ok: false, classification: matches.length ? "integrity-blocked" : "foreign", safe: { reason: "unsafe or absent worktree registration" } };
      const item = matches[0]; const top = realpathSync(await git(canonicalPath, ["rev-parse", "--show-toplevel"]));
      const common = realpathSync(resolve(top, await git(canonicalPath, ["rev-parse", "--git-common-dir"])));
      if (top !== canonicalPath || common !== identity.repositoryCommonDir || item.branch !== record.branch) return { ok: false, classification: "integrity-blocked", safe: { reason: "registered root, common dir, or branch mismatch" } };
      const head = await git(canonicalPath, ["rev-parse", "HEAD"]); const mergeBase = await git(canonicalPath, ["merge-base", record.intendedBaseSha, head]);
      if (mergeBase !== record.intendedBaseSha) return { ok: false, classification: "integrity-blocked", safe: { reason: "base ancestry mismatch" } };
      const clean = await cleanStatus(canonicalPath);
      return { ok: true, canonicalPath, head, clean, exactBase: head === record.intendedBaseSha, safe: { registered: true, clean, exactBase: head === record.intendedBaseSha, branch: record.branch } };
    } catch (error) { return { ok: false, classification: "integrity-blocked", safe: { reason: String(error.message).slice(0, 300) } }; }
  }

  async reconcile({ taskForRecord = () => null } = {}) {
    if (!this.store) return [];
    const outcomes = [];
    for (const record of this.store.listManagedWorktrees()) {
      const verified = await this.verifyRecord(record.recordId);
      let classification = verified.classification ?? "active"; let phase = record.phase;
      if (verified.ok) {
        const task = taskForRecord(record);
        if (record.phase === "intent_recorded") phase = "linked";
        if (record.phase === "finalized") classification = verified.clean ? "finalized-reclaimable" : "preserved-failure";
        else if (!verified.clean || ["running", "failed", "interrupted"].includes(task?.status)) classification = "preserved-failure";
        else if (record.taskId && !task) classification = "orphan-managed";
        this.store.updateManagedWorktree(record.recordId, { phase, classification, canonicalPath: verified.canonicalPath, lastVerifiedHead: verified.head, verification: verified.safe });
      } else this.store.updateManagedWorktree(record.recordId, { phase: "preserved", classification, verification: verified.safe });
      outcomes.push({ recordId: record.recordId, kind: record.kind, phase, classification });
    }
    return outcomes;
  }

  async adoptPreparedWorker(task) {
    if (!this.store) return null;
    const candidates = this.store.listManagedWorktrees().filter((record) => record.taskId === task.id && record.kind === "worker" && ["intent_recorded", "git_created", "linked"].includes(record.phase));
    for (const record of candidates) {
      const verified = await this.verifyRecord(record.recordId);
      if (verified.ok && verified.clean && verified.exactBase && !task.threadId && !task.turnId && task.status === "preparing") return this.store.linkManagedWorktree(record.recordId, { canonicalPath: verified.canonicalPath, lastVerifiedHead: verified.head, verification: verified.safe, taskId: task.id });
      this.store.updateManagedWorktree(record.recordId, { phase: "preserved", classification: verified.ok ? "preserved-failure" : verified.classification, verification: verified.safe });
    }
    return null;
  }

  // Deliberately retained but unused by managed recovery. No caller is added.
  async remove(worktree) { const target = resolve(worktree); if (!within(this.root, target)) throw new Error(`Refuse to remove worktree outside runtime root: ${target}`); await exec("git", ["-C", this.repository, "worktree", "remove", "--force", target]); }
  async recovery(worktree) { const target = resolve(worktree); if (!within(this.root, target)) throw new Error(`Refuse recovery outside runtime root: ${target}`); return { worktree: target, clean: await cleanStatus(target), action: "Inspect or preserve this isolated worktree; remove it explicitly only after recovery is complete." }; }
}
