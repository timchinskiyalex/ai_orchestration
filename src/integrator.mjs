import { closeSync, mkdirSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { validateWorkerArtifact } from "./worktree-finalizer.mjs";
import { commandCwd, commandsForPaths } from "./project-overlay.mjs";
import { runManagedProcess } from "./managed-process-runner.mjs";
import { validateIntegrationBarrier } from "./workflow-contract.mjs";
import { RUNTIME_GIT_IDENTITY, runtimeGitIdentityArgs } from "./runtime-git-identity.mjs";

const exec = promisify(execFile);
const toPosix = (value) => value.replace(/\\/g, "/");
async function git(cwd, args) { return (await exec("git", ["-C", cwd, ...args])).stdout.trim(); }
async function gitRaw(cwd, args) { return (await exec("git", ["-C", cwd, ...args], { encoding: "buffer" })).stdout.toString("utf8"); }
function nameStatusPaths(value) { const parts = value.split("\0"); const paths = []; for (let i = 0; i < parts.length; i += 1) { const status = parts[i]; if (!status) continue; if ((status.startsWith("R") || status.startsWith("C")) && parts[i + 2] !== undefined) paths.push(toPosix(parts[++i]), toPosix(parts[++i])); else if (parts[i + 1] !== undefined) paths.push(toPosix(parts[++i])); } return paths; }
const intersects = (a, b) => a.some((path) => b.some((other) => path === other || path.startsWith(`${other}/`) || other.startsWith(`${path}/`)));
const sensitiveArea = (path) => /(^|\/)(migrations?|infra|terraform|k8s|helm|\.github\/workflows)(\/|$)/i.test(path);
const checksum = (value) => createHash("sha256").update(value).digest("hex");

export class Integrator {
  constructor({ repository, runtimeDir, generatedDir, project = {}, integration = {}, runtimeIdentity = RUNTIME_GIT_IDENTITY, processRunner = runManagedProcess, worktrees = null, deliveryRunId = null }) {
    this.repository = repository;
    this.runtimeDir = runtimeDir;
    // Router owns generatedDir under the project contract, while direct callers
    // may supply it explicitly.  Both are controller configuration, never a
    // worker-provided value.
    this.generatedDir = generatedDir ?? project.generatedDir;
    if (!this.generatedDir) throw new Error("Integrator requires project.generatedDir");
    this.integration = integration;
    this.runtimeIdentity = runtimeIdentity;
    this.processRunner = processRunner;
    this.worktrees = worktrees;
    this.deliveryRunId = deliveryRunId;
  }

  async integrate({ artifacts, overlay, baseSha = overlay.repository.baseSha, allowedBaseShas = [], lineage = null }) {
    const root = resolve(this.runtimeDir, "integrations");
    mkdirSync(root, { recursive: true });
    const lockPath = join(root, ".integration.lock");
    let lock;
    try { lock = openSync(lockPath, "wx"); }
    catch { throw new Error("Integration is already running; concurrent candidate branches are blocked by the integration lock"); }
    try { return await this.#integrateUnlocked({ artifacts, overlay, baseSha, allowedBaseShas, lineage }); }
    finally { closeSync(lock); try { unlinkSync(lockPath); } catch { /* lock cleanup is best effort */ } }
  }

  async integrateBarrier({ barrier, artifacts, effectiveArtifacts = artifacts, effectiveLineage = null, allowedBaseShas = [], overlay }) {
    validateIntegrationBarrier(barrier);
    if (!Array.isArray(artifacts) || artifacts.length !== barrier.inputArtifacts.length) throw new Error("IntegrationBarrier artifacts do not match immutable inputs");
    const byId = new Map(artifacts.map((artifact) => [artifact.taskId, artifact]));
    const ordered = barrier.inputArtifacts.map((input) => { const artifact = byId.get(input.artifactId); if (!artifact || artifact.headSha !== input.headSha) throw new Error(`IntegrationBarrier input ${input.artifactId} does not match its verified identity`); return artifact; });
    ordered.forEach(validateWorkerArtifact);
    for (const artifact of ordered) await this.#verifyArtifactIntegrity(artifact);
    const effectiveOrder = this.#effectiveOrder(effectiveArtifacts, effectiveLineage);
    const effective = effectiveOrder.artifacts;
    const permittedBases = new Set([barrier.baseSha, ...allowedBaseShas]);
    await this.#validateEffectiveBases(effective, { permittedBases, label: "Barrier artifact" });
    const root = resolve(this.runtimeDir, "integrations"); const id = barrier.id;
    let worktree = join(root, `barrier-${id}`), branch = `swarm/barrier/${id}`, managed = null;
    try {
      if (this.worktrees) { managed = await this.worktrees.createManaged({ kind: "integration_barrier", barrierId: id, deliveryRunId: barrier.deliveryRunId, planBatchId: barrier.planBatchId ?? null, baseSha: barrier.baseSha }); worktree = managed.canonicalPath; branch = managed.branch; }
      else { mkdirSync(root, { recursive: true }); const existing = await git(this.repository, ["branch", "--list", branch]); if (!existing) await exec("git", ["-C", this.repository, "worktree", "add", "-b", branch, worktree, barrier.baseSha]); else await exec("git", ["-C", this.repository, "worktree", "add", worktree, branch]); }
      for (const artifact of effective) await this.#gitWithRuntimeIdentity(worktree, ["cherry-pick", artifact.headSha]);
      const verificationResults = [], verificationPlan = commandsForPaths(overlay, (overlay.components ?? []).filter((component) => component.state === "scaffolded").map((component) => component.root));
      if (verificationPlan.missing.length) throw new Error("Barrier verification unavailable for a scaffolded component");
      for (const command of verificationPlan.commands) { try { const result = await this.processRunner({ executable: command.executable, args: command.args, cwd: commandCwd(worktree, command), timeoutMs: command.timeoutMs ?? 120_000 }); verificationResults.push({ id: command.id, status: "passed", pid: result.pid, stdout: result.stdout.slice(-4000), stderr: result.stderr.slice(-4000) }); } catch (error) { verificationResults.push({ id: command.id, status: "failed", error: error.message }); throw Object.assign(new Error(`Barrier verification failed: ${command.id}`), { verificationResults }); } }
      const [outputSha, clean] = await Promise.all([git(worktree, ["rev-parse", "HEAD"]), gitRaw(worktree, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])]); if (clean) throw new Error("Barrier worktree is not clean"); await git(this.repository, ["rev-parse", "--verify", `${outputSha}^{commit}`]); if (managed) this.worktrees.store.updateManagedWorktree(managed.recordId, { phase: "finalized", classification: "active", lastVerifiedHead: outputSha, finalized: true }); return { status: "passed", id, worktree, branch, outputSha, verificationResults };
    } catch (error) { /* A conflicted or failed worktree is evidence; never abort/reset it here. */ if (managed) this.worktrees.store.updateManagedWorktree(managed.recordId, { phase: "preserved", classification: "preserved-failure" }); return { status: "failed", id, worktree, branch, error: error.message, verificationResults: error.verificationResults ?? [] }; }
  }

  async #integrateUnlocked({ artifacts, overlay, baseSha, allowedBaseShas, lineage }) {
    if (!Array.isArray(artifacts) || !artifacts.length) throw new Error("Integrator requires at least one WorkerArtifact");
    artifacts.forEach(validateWorkerArtifact);
    const effectiveOrder = this.#effectiveOrder(artifacts, lineage);
    const sorted = effectiveOrder.artifacts;
    await this.#validateEffectiveBases(sorted, { permittedBases: new Set([baseSha, ...allowedBaseShas]), label: "Artifact" });
    for (let i = 0; i < sorted.length; i += 1) for (let j = 0; j < i; j += 1) {
      const chained = this.#isEffectiveAncestor(sorted[i], sorted[j], effectiveOrder);
      if (chained) continue;
      if (intersects(sorted[i].changedPaths, sorted[j].changedPaths) || (sorted[i].changedPaths.some(sensitiveArea) && sorted[j].changedPaths.some(sensitiveArea))) {
        return this.#blocked(overlay, sorted, `CONFLICT_BLOCKED: semantic/security/migration/infrastructure path overlap between ${sorted[j].taskId} and ${sorted[i].taskId}`);
      }
    }
    // A delivery retry must address the same candidate ownership record, not
    // manufacture a second candidate worktree for identical durable inputs.
    const id = this.deliveryRunId ? `candidate-${checksum(JSON.stringify({ run: this.deliveryRunId, baseSha, lineage: lineage ?? sorted.map((artifact) => [artifact.taskId, artifact.headSha]) })).slice(0, 32)}` : randomUUID();
    const root = resolve(this.runtimeDir, "integrations");
    let worktree = join(root, id);
    let branch = `swarm/candidate/${id}`;
    let managed = null;
    if (this.worktrees) { managed = await this.worktrees.createManaged({ kind: "candidate_integration", candidateId: id, deliveryRunId: this.deliveryRunId, baseSha }); worktree = managed.canonicalPath; branch = managed.branch; }
    else { mkdirSync(root, { recursive: true }); await exec("git", ["-C", this.repository, "worktree", "add", "-b", branch, worktree, baseSha]); }
    const applied = [];
    try {
      for (const artifact of sorted) {
        try { await this.#gitWithRuntimeIdentity(worktree, ["cherry-pick", artifact.headSha]); applied.push(artifact.taskId); }
        catch { await git(worktree, ["cherry-pick", "--abort"]); return this.#blocked(overlay, sorted, `CONFLICT_BLOCKED: cherry-pick failed for ${artifact.taskId}`, { id, branch, worktree, applied }); }
      }
      const verificationResults = [];
      const verificationPlan = commandsForPaths(overlay, (overlay.components ?? []).filter((component) => component.state === "scaffolded").map((component) => component.root));
      if (verificationPlan.missing.length) return this.#blocked(overlay, sorted, "CONFLICT_BLOCKED: integration verification unavailable for a scaffolded component", { id, branch, worktree, applied, verificationResults });
      for (const command of verificationPlan.commands) {
        try { const result = await this.processRunner({ executable: command.executable, args: command.args, cwd: commandCwd(worktree, command), timeoutMs: command.timeoutMs ?? 120_000 }); verificationResults.push({ id: command.id, status: "passed", pid: result.pid, stdout: result.stdout.slice(-4000), stderr: result.stderr.slice(-4000) }); }
        catch (error) { verificationResults.push({ id: command.id, status: "failed", error: error.message, pid: error.pid ?? null, timedOut: Boolean(error.timedOut), stdout: String(error.stdout ?? "").slice(-4000), stderr: String(error.stderr ?? "").slice(-4000) }); return this.#blocked(overlay, sorted, `CONFLICT_BLOCKED: integration verification failed (${command.id})`, { id, branch, worktree, applied, verificationResults }); }
      }
      const [headSha, clean] = await Promise.all([git(worktree, ["rev-parse", "HEAD"]), gitRaw(worktree, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])]);
      if (clean) throw new Error("Integration worktree is not clean");
      if (managed) this.worktrees.store.updateManagedWorktree(managed.recordId, { phase: "finalized", classification: "active", lastVerifiedHead: headSha, finalized: true });
      return this.#writeManifest({ id, status: "candidate_ready", branch, worktree, baseSha, candidateSha: headSha, headSha, appliedArtifacts: applied, effectiveLineage: lineage ?? sorted.map((artifact) => ({ kind: "artifact", id: artifact.taskId, sha: artifact.headSha })), verificationResults, localVerification: { status: "passed", commands: verificationResults }, remoteCi: this.#extensionStatus("remote CI", this.integration.remoteCiExtension), pullRequest: this.#extensionStatus("pull request", this.integration.pullRequestExtension), blockedReason: null, rollback: { baseSha, resetCommand: `git switch ${branch} && git reset --hard ${baseSha}` }, recovery: { mode: "preserved-worktree", worktree, action: "Candidate worktree is retained for diagnosis and can be removed after merge verification." }, humanMergeGate: { required: false, targetBranch: overlay.repository.branch, candidateSha: headSha, action: "autonomous PR and merge when remote checks pass" } });
    } catch (error) { if (managed) this.worktrees.store.updateManagedWorktree(managed.recordId, { phase: "preserved", classification: "preserved-failure" }); return this.#blocked(overlay, sorted, `CONFLICT_BLOCKED: integration exception: ${error.message}`, { id, branch, worktree, applied }); }
  }

  #blocked(overlay, artifacts, reason, details = {}) {
    return this.#writeManifest({ id: details.id ?? randomUUID(), status: "CONFLICT_BLOCKED", reason, blockedReason: reason, branch: details.branch ?? null, worktree: details.worktree ?? null, baseSha: overlay.repository.baseSha, candidateSha: null, headSha: null, appliedArtifacts: details.applied ?? [], artifacts: artifacts.map((item) => item.taskId), verificationResults: details.verificationResults ?? [], localVerification: { status: details.verificationResults?.some((item) => item.status === "failed") ? "failed" : "not-run", commands: details.verificationResults ?? [] }, remoteCi: this.#extensionStatus("remote CI", this.integration.remoteCiExtension), pullRequest: this.#extensionStatus("pull request", this.integration.pullRequestExtension), recovery: { mode: "preserved-worktree", worktree: details.worktree ?? null, action: "Resolve the blocked condition manually; run git cherry-pick --abort if needed, then remove the candidate worktree before retrying." }, humanMergeGate: { required: true, action: "resolve conflict outside Integrator and retry" } });
  }

  #effectiveOrder(artifacts, lineage) {
    if (!Array.isArray(artifacts) || !artifacts.length) throw new Error("Effective integration order requires artifacts");
    const byId = new Map();
    for (const artifact of artifacts) {
      validateWorkerArtifact(artifact);
      if (byId.has(artifact.taskId)) throw new Error(`Effective integration order contains duplicate artifact ${artifact.taskId}`);
      byId.set(artifact.taskId, artifact);
    }
    if (!lineage) return { artifacts: this.#dependencyOrder(artifacts), lineage: null, checkpointPositions: new Map(), artifactPositions: new Map() };
    if (!Array.isArray(lineage) || !lineage.length) throw new Error("Effective integration order requires a controller-derived lineage");
    const seen = new Set(), ordered = [], checkpointPositions = new Map(), artifactPositions = new Map();
    for (let index = 0; index < lineage.length; index += 1) {
      const node = lineage[index];
      if (!node || !["artifact", "checkpoint"].includes(node.kind) || typeof node.id !== "string" || !node.id || !/^[a-f0-9]{40,64}$/i.test(node.sha ?? "")) throw new Error("Effective integration lineage contains an invalid node");
      const identity = `${node.kind}:${node.id}`;
      if (seen.has(identity)) throw new Error(`Effective integration lineage contains duplicate ${identity}`);
      seen.add(identity);
      if (node.kind === "checkpoint") {
        if (checkpointPositions.has(node.sha)) throw new Error(`Effective integration lineage contains duplicate checkpoint output ${node.sha}`);
        checkpointPositions.set(node.sha, index);
        continue;
      }
      const artifact = byId.get(node.id);
      if (!artifact || artifact.headSha !== node.sha) throw new Error(`Effective integration lineage artifact ${node.id} is missing or inconsistent`);
      ordered.push(artifact); artifactPositions.set(node.id, index);
    }
    if (ordered.length !== byId.size) throw new Error("Effective integration lineage is missing artifacts");
    for (const artifact of ordered) {
      const position = artifactPositions.get(artifact.taskId);
      for (const dependency of artifact.dependencies ?? []) {
        const dependencyPosition = artifactPositions.get(dependency);
        if (dependencyPosition === undefined) throw new Error(`Effective integration lineage is missing dependency ${dependency} for ${artifact.taskId}`);
        if (dependencyPosition >= position) throw new Error(`Effective integration lineage is not topological for ${artifact.taskId}`);
      }
      const checkpointPosition = checkpointPositions.get(artifact.baseSha);
      if (checkpointPosition !== undefined && checkpointPosition >= position) throw new Error(`Effective integration lineage applies ${artifact.taskId} before its base checkpoint`);
    }
    return { artifacts: ordered, lineage, checkpointPositions, artifactPositions };
  }

  async #validateEffectiveBases(artifacts, { permittedBases, label }) {
    const byTaskId = new Map(artifacts.map((artifact) => [artifact.taskId, artifact]));
    for (const artifact of artifacts) {
      validateWorkerArtifact(artifact);
      const dependencies = artifact.dependencies ?? [];
      const artifactParents = dependencies.map((id) => byTaskId.get(id));
      if (artifactParents.some((parent) => !parent)) throw new Error(`${label} ${artifact.taskId} dependency is missing from its effective lineage`);
      if (artifactParents.length > 1) throw new Error(`${label} ${artifact.taskId} has multiple artifact parents; chained artifacts require one deterministic predecessor`);
      const expectedBase = artifactParents[0]?.headSha;
      if (expectedBase ? artifact.baseSha !== expectedBase : !permittedBases.has(artifact.baseSha)) throw new Error(`${label} ${artifact.taskId} has an unproved effective base`);
      await this.#verifyArtifactIntegrity(artifact);
    }
  }

  #isEffectiveAncestor(later, earlier, effectiveOrder) {
    if ((later.dependencies ?? []).includes(earlier.taskId)) return true;
    const checkpointPosition = effectiveOrder.checkpointPositions.get(later.baseSha);
    if (checkpointPosition === undefined || !effectiveOrder.lineage) return false;
    return effectiveOrder.lineage.findIndex((node) => node.kind === "artifact" && node.id === earlier.taskId) < checkpointPosition;
  }

  #dependencyOrder(artifacts) {
    const byId = new Map(artifacts.map((artifact) => [artifact.taskId, artifact]));
    const ordered = [];
    const pending = new Map([...byId].map(([id, artifact]) => [id, (artifact.dependencies ?? []).filter((dependency) => byId.has(dependency))]));
    while (pending.size) {
      const ready = [...pending.entries()].filter(([, dependencies]) => dependencies.every((dependency) => ordered.some((artifact) => artifact.taskId === dependency))).map(([id]) => id).sort();
      if (!ready.length) throw new Error("WorkerArtifact dependency graph contains a cycle");
      for (const id of ready) { ordered.push(byId.get(id)); pending.delete(id); }
    }
    return ordered;
  }
  async #gitWithRuntimeIdentity(cwd, args) { return git(cwd, [...runtimeGitIdentityArgs(this.runtimeIdentity), ...args]); }
  async #verifyArtifactIntegrity(artifact) { const mergeBase = await git(this.repository, ["merge-base", artifact.baseSha, artifact.headSha]); if (mergeBase !== artifact.baseSha) throw new Error(`Artifact ${artifact.taskId} is not descended from its base SHA`); const [diff, names, treeSha] = await Promise.all([git(this.repository, ["diff", "--binary", "--no-ext-diff", artifact.baseSha, artifact.headSha, "--"]), gitRaw(this.repository, ["diff", "--name-status", "-z", artifact.baseSha, artifact.headSha, "--"]), git(this.repository, ["rev-parse", `${artifact.headSha}^{tree}`])]); if (checksum(diff) !== artifact.diffChecksum) throw new Error(`Artifact ${artifact.taskId} diff checksum mismatch`); if (treeSha !== artifact.treeSha) throw new Error(`Artifact ${artifact.taskId} tree SHA mismatch`); if (JSON.stringify(nameStatusPaths(names).sort()) !== JSON.stringify([...artifact.changedPaths].sort())) throw new Error(`Artifact ${artifact.taskId} changed paths mismatch`); }

  #writeManifest(manifest) {
    const value = { schemaVersion: 1, kind: "IntegrationManifest", generatedAt: new Date().toISOString(), ...manifest };
    const directory = join(this.repository, this.generatedDir, "integration-manifests");
    mkdirSync(directory, { recursive: true });
    const path = join(directory, `${value.id}.v1.json`);
    writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf8");
    return { manifest: value, path: toPosix(relative(this.repository, path)) };
  }

  #extensionStatus(kind, extension) {
    return extension ? { status: "unavailable", extension, reason: `${kind} extension is configured but no adapter is implemented in this template` } : { status: "unavailable", reason: `${kind} requires a separately configured adapter and credentials; no remote action was attempted` };
  }
}
