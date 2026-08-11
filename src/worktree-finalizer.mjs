import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { commandCwd, commandsForPaths } from "./project-overlay.mjs";
import { runManagedProcess } from "./managed-process-runner.mjs";

const exec = promisify(execFile);
const ARTIFACT_VERSION = 1;
const toPosix = (value) => value.replace(/\\/g, "/");
const digest = (value) => createHash("sha256").update(value).digest("hex");
async function git(cwd, args) { return (await exec("git", ["-C", cwd, ...args])).stdout.trim(); }
async function gitRaw(cwd, args) { return (await exec("git", ["-C", cwd, ...args], { encoding: "buffer" })).stdout.toString("utf8"); }
function statusPaths(value) { return value.split("\0").filter(Boolean).map((entry) => toPosix(entry.slice(3))); }
function nameStatusPaths(value) { const parts = value.split("\0"); const paths = []; for (let i = 0; i < parts.length; i += 1) { const status = parts[i]; if (!status) continue; if ((status.startsWith("R") || status.startsWith("C")) && parts[i + 2] !== undefined) paths.push(toPosix(parts[++i]), toPosix(parts[++i])); else if (parts[i + 1] !== undefined) paths.push(toPosix(parts[++i])); } return paths; }
function isWithin(path, allowed) { return path === allowed || path.startsWith(`${allowed.replace(/\/$/, "")}/`); }
function pathAllowed(path, task, overlay, { autonomous = true } = {}) {
  if (!task.allowedPaths?.length || !task.allowedPaths.some((allowed) => isWithin(path, allowed))) return { allowed: false, reason: "outside TaskEnvelope allowedPaths" };
  const policies = overlay.pathPolicies ?? {};
  if ((policies.denyWrite ?? []).some((item) => isWithin(path, item))) return { allowed: false, reason: "deny_write policy" };
  if ((policies.generatedDoNotEdit ?? []).some((item) => isWithin(path, item))) return { allowed: false, reason: "generated_do_not_edit policy" };
  if ((policies.approvalRequired ?? []).some((item) => isWithin(path, item)) && !task.humanApproved && !autonomous) return { allowed: false, reason: "approval_required policy needs recorded human approval in manual mode" };
  return { allowed: true };
}

export class WorktreeFinalizer {
  constructor({ repository, generatedDir, autonomy = {}, runtimeIdentity = { name: "Codex Swarm Runtime", email: "codex-swarm-runtime@localhost" }, processRunner = runManagedProcess }) {
    this.repository = repository;
    this.generatedDir = generatedDir;
    this.autonomous = autonomy.mode !== "manual";
    this.runtimeIdentity = runtimeIdentity;
    this.processRunner = processRunner;
  }

  async finalize({ task, worktree, branch, overlay, overlayPath }) {
    if (!worktree || !branch) throw new Error("Writer task has no isolated worktree or branch");
    const artifactBaseSha = task.artifactBaseSha ?? overlay.repository.baseSha;
    const [worktreeRoot, headBefore, mergeBase, status, names] = await Promise.all([
      git(worktree, ["rev-parse", "--show-toplevel"]), git(worktree, ["rev-parse", "HEAD"]),
      git(worktree, ["merge-base", artifactBaseSha, "HEAD"]), gitRaw(worktree, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
      gitRaw(worktree, ["diff", "--name-status", "-z", artifactBaseSha, "--"])
    ]);
    if (mergeBase !== artifactBaseSha) throw new Error(`Worktree does not descend from artifact base SHA ${artifactBaseSha}`);
    if (headBefore !== artifactBaseSha) throw new Error("Worker created commits; only the runtime/controller may commit a WorkerArtifact");
    const changedPaths = [...new Set([...nameStatusPaths(names), ...statusPaths(status)])];
    if (!changedPaths.length) throw new Error("Worker produced no diff; refusing to create an empty WorkerArtifact");
    const violations = changedPaths.map((path) => ({ path, ...pathAllowed(path, task, overlay, { autonomous: this.autonomous }) })).filter((item) => !item.allowed);
    if (violations.length) throw new Error(`Finalizer policy violation: ${violations.map((item) => `${item.path} (${item.reason})`).join(", ")}`);
    if (!status) throw new Error("Finalizer expected a dirty worktree");
    const verificationResults = [];
    const verificationPlan = commandsForPaths(overlay, changedPaths);
    if (verificationPlan.missing.length) throw new Error("Verification unavailable for a changed scaffolded product component");
    for (const command of verificationPlan.commands) {
      try {
        const result = await this.processRunner({ executable: command.executable, args: command.args, cwd: commandCwd(worktree, command), timeoutMs: command.timeoutMs ?? 120_000 });
        verificationResults.push({ id: command.id, source: command.source, status: "passed", pid: result.pid, stdout: result.stdout.slice(-4000), stderr: result.stderr.slice(-4000) });
      } catch (error) {
        verificationResults.push({ id: command.id, source: command.source, status: "failed", error: error.message, pid: error.pid ?? null, timedOut: Boolean(error.timedOut), stdout: String(error.stdout ?? "").slice(-4000), stderr: String(error.stderr ?? "").slice(-4000) });
        throw new Error(`Verification failed: ${command.id}: ${String(error.stderr ?? error.stdout ?? error.message).slice(-1000)}`);
      }
    }
    const afterVerificationStatus = await gitRaw(worktree, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    const afterVerificationPaths = [...new Set(statusPaths(afterVerificationStatus))];
    const newlyCreatedPaths = afterVerificationPaths.filter((path) => !changedPaths.includes(path));
    if (newlyCreatedPaths.length) throw new Error(`Verification left unstaged files in the worktree: ${newlyCreatedPaths.join(", ")}`);
    await git(worktree, ["add", "--", ...changedPaths]);
    // Git's staged name list is canonical on case-insensitive filesystems.
    // Status porcelain can retain the spelling an agent used for a path even
    // when that path resolves to an existing directory with different case.
    const stagedPaths = [...new Set((await gitRaw(worktree, ["diff", "--cached", "--name-only", "-z", "--"])).split("\0").filter(Boolean).map(toPosix))];
    if (!stagedPaths.length) throw new Error("Finalizer staging produced no changed paths");
    const diff = await git(worktree, ["diff", "--cached", "--binary", "--no-ext-diff", artifactBaseSha, "--"]);
    if (!diff) throw new Error("Finalizer staging produced no diff");
    await exec("git", ["-C", worktree, "-c", `user.name=${this.runtimeIdentity.name}`, "-c", `user.email=${this.runtimeIdentity.email}`, "commit", "-m", `swarm: finalize ${task.id}`]);
    const [headSha, treeSha, clean] = await Promise.all([
      git(worktree, ["rev-parse", "HEAD"]), git(worktree, ["rev-parse", "HEAD^{tree}"]), gitRaw(worktree, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])
    ]);
    if (clean) throw new Error("Finalized worktree is not clean");
    const artifact = {
      schemaVersion: ARTIFACT_VERSION, kind: "WorkerArtifact", taskId: task.id, workUnitId: task.workUnitId ?? task.id, workerId: task.role,
      baseSha: artifactBaseSha, branch, headSha, treeSha, commitRange: `${headBefore}..${headSha}`,
      diffChecksum: digest(diff), changedPaths: stagedPaths, verificationResults, policyResult: { status: "passed", violations: [] },
      overlay: { schemaVersion: overlay.schemaVersion, path: overlayPath }, dependencies: task.artifactDependencies ?? task.dependencies ?? [],
      finalizedBy: { component: "WorktreeFinalizer", version: ARTIFACT_VERSION, identity: this.runtimeIdentity.name, finalizedAt: new Date().toISOString(), worktreeRoot: toPosix(worktreeRoot) }
    };
    const artifactsDir = join(this.repository, this.generatedDir, "worker-artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    const absolutePath = join(artifactsDir, `${task.id}.v${ARTIFACT_VERSION}.json`);
    writeFileSync(absolutePath, JSON.stringify(artifact, null, 2) + "\n", "utf8");
    return { artifact, path: toPosix(relative(this.repository, absolutePath)) };
  }
}

export function validateWorkerArtifact(value) {
  if (!value || value.schemaVersion !== ARTIFACT_VERSION || value.kind !== "WorkerArtifact") throw new Error("Invalid WorkerArtifact version or kind");
  for (const key of ["taskId", "baseSha", "branch", "headSha", "treeSha", "commitRange", "diffChecksum", "changedPaths", "verificationResults", "policyResult", "overlay", "finalizedBy"]) if (!(key in value)) throw new Error(`WorkerArtifact missing ${key}`);
  if (!Array.isArray(value.changedPaths) || !value.changedPaths.length || !/^[a-f0-9]{64}$/i.test(value.diffChecksum)) throw new Error("WorkerArtifact contains invalid diff metadata");
  if (value.policyResult.status !== "passed" || value.verificationResults.some((item) => item.status !== "passed")) throw new Error("WorkerArtifact verification or policy did not pass");
  return value;
}
