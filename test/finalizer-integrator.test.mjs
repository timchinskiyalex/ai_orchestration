import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { generateProjectOverlay } from "../src/project-overlay.mjs";
import { WorktreeFinalizer } from "../src/worktree-finalizer.mjs";
import { Integrator } from "../src/integrator.mjs";
import { RUNTIME_GIT_IDENTITY } from "../src/runtime-git-identity.mjs";

const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

test("finalizer produces a clean, committed artifact and integrator creates a candidate branch", async () => {
  const root = mkdtempSync(join(tmpdir(), "orchestration-finalize-"));
  try {
    git(root, ["init", "-b", "main"]);
    writeFileSync(join(root, "package.json"), JSON.stringify({ packageManager: "npm@10.0.0", scripts: { test: "node --test" } }), "utf8");
    writeFileSync(join(root, "package-lock.json"), "{}", "utf8");
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "test"));
    writeFileSync(join(root, "src", "value.mjs"), "export const value = 1;\n", "utf8");
    writeFileSync(join(root, "test", "value.test.mjs"), "import test from 'node:test'; import assert from 'node:assert/strict'; import { value } from '../src/value.mjs'; test('value', () => assert.equal(value, 2));\n", "utf8");
    git(root, ["add", "."]); git(root, ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "base"]);
    const { overlay, path } = await generateProjectOverlay({ repository: root, baseRef: "main" });
    const worktree = join(root, "runtime", "worktrees", "writer");
    mkdirSync(join(root, "runtime", "worktrees"), { recursive: true });
    git(root, ["worktree", "add", "-b", "swarm/writer", worktree, overlay.repository.baseSha]);
    assert.equal(existsSync(join(worktree, "docs", "orchestration-generated", "project-overlay.v1.json")), false, "untracked controller Overlay must not be copied into a fresh writer worktree");
    writeFileSync(join(worktree, "src", "value.mjs"), "export const value = 2;\n", "utf8");
    const finalizer = new WorktreeFinalizer({ repository: root, generatedDir: "docs/orchestration-generated" });
    const finalized = await finalizer.finalize({ task: { id: "writer", role: "backend", allowedPaths: ["src"], dependencies: [] }, worktree, branch: "swarm/writer", overlay, overlayPath: path });
    assert.equal(finalized.artifact.verificationResults[0].status, "passed");
    assert.equal(git(worktree, ["status", "--porcelain"]), "");
    const integration = await new Integrator({ repository: root, runtimeDir: join(root, "runtime"), generatedDir: "docs/orchestration-generated" }).integrate({ artifacts: [finalized.artifact], overlay });
    assert.equal(integration.manifest.status, "candidate_ready");
    assert.equal(integration.manifest.localVerification.status, "passed");
    assert.equal(integration.manifest.remoteCi.status, "unavailable");
    assert.equal(integration.manifest.pullRequest.status, "unavailable");
    assert.equal(git(integration.manifest.worktree, ["status", "--porcelain"]), "");
    execFileSync(process.execPath, ["--test"], { cwd: integration.manifest.worktree, stdio: "pipe" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("integration and barrier cherry-picks create runtime-identified commits without global Git identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "orchestration-runtime-identity-"));
  const savedGlobal = process.env.GIT_CONFIG_GLOBAL;
  const savedNoSystem = process.env.GIT_CONFIG_NOSYSTEM;
  try {
    git(root, ["init", "-b", "main"]);
    writeFileSync(join(root, "package.json"), JSON.stringify({ packageManager: "npm@10", scripts: {} }), "utf8");
    writeFileSync(join(root, "package-lock.json"), "{}", "utf8");
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "base.mjs"), "export const base = true;\n", "utf8");
    git(root, ["add", "."]); git(root, ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "base"]);
    process.env.GIT_CONFIG_GLOBAL = join(root, "no-global-gitconfig");
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    assert.throws(() => git(root, ["config", "--local", "--get", "user.name"]));
    const { overlay, path } = await generateProjectOverlay({ repository: root, baseRef: "main" });
    const finalizer = new WorktreeFinalizer({ repository: root, generatedDir: "docs/orchestration-generated" });
    const artifacts = [];
    for (const id of ["writer-a", "writer-b"]) {
      const worktree = join(root, id);
      git(root, ["worktree", "add", "-b", `swarm/${id}`, worktree, overlay.repository.baseSha]);
      writeFileSync(join(worktree, "src", `${id}.mjs`), `export const ${id.replace("-", "_")} = true;\n`, "utf8");
      artifacts.push((await finalizer.finalize({ task: { id, role: "backend", allowedPaths: ["src"], dependencies: [] }, worktree, branch: `swarm/${id}`, overlay, overlayPath: path })).artifact);
    }
    const integrator = new Integrator({ repository: root, runtimeDir: join(root, "runtime"), generatedDir: "docs/orchestration-generated" });
    const integration = await integrator.integrate({ artifacts, overlay });
    assert.equal(integration.manifest.status, "candidate_ready");
    const barrier = { schemaVersion: 1, kind: "IntegrationBarrier", id: "identity-barrier", deliveryRunId: "run-identity", blueprintId: "blueprint-identity", wave: 1, baseSha: overlay.repository.baseSha, inputArtifacts: artifacts.map(({ taskId, headSha }) => ({ artifactId: taskId, headSha })), status: "pending", createdAt: "2026-01-01T00:00:00.000Z" };
    const barrierResult = await integrator.integrateBarrier({ barrier, artifacts, overlay });
    assert.equal(barrierResult.status, "passed");
    const identity = `${RUNTIME_GIT_IDENTITY.name} <${RUNTIME_GIT_IDENTITY.email}>|${RUNTIME_GIT_IDENTITY.name} <${RUNTIME_GIT_IDENTITY.email}>`;
    for (const worktree of [integration.manifest.worktree, barrierResult.worktree]) assert.equal(git(worktree, ["show", "-s", "--format=%an <%ae>|%cn <%ce>", "HEAD"]), identity);
  } finally {
    if (savedGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = savedGlobal;
    if (savedNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM; else process.env.GIT_CONFIG_NOSYSTEM = savedNoSystem;
    rmSync(root, { recursive: true, force: true });
  }
});

test("integrator deterministically records blocked overlapping artifacts for recovery", async () => {
  const root = mkdtempSync(join(tmpdir(), "orchestration-blocked-"));
  try {
    git(root, ["init", "-b", "main"]); writeFileSync(join(root, "package.json"), JSON.stringify({ packageManager: "npm@10", scripts: {} }), "utf8"); writeFileSync(join(root, "package-lock.json"), "{}", "utf8"); writeFileSync(join(root, "value.txt"), "a\n", "utf8");
    git(root, ["add", "."]); git(root, ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "base"]);
    const { overlay } = await generateProjectOverlay({ repository: root, baseRef: "main" });
    const base = overlay.repository.baseSha; const worktree = join(root, "writer"); git(root, ["worktree", "add", "-b", "swarm/writer", worktree, base]); writeFileSync(join(worktree, "value.txt"), "b\n", "utf8");
    const finalized = await new WorktreeFinalizer({ repository: root, generatedDir: "docs/orchestration-generated" }).finalize({ task: { id: "one", role: "backend", allowedPaths: ["value.txt"], dependencies: [] }, worktree, branch: "swarm/writer", overlay, overlayPath: "overlay" });
    const duplicate = { ...finalized.artifact, taskId: "two" };
    const blocked = await new Integrator({ repository: root, runtimeDir: join(root, "runtime"), generatedDir: "docs/orchestration-generated" }).integrate({ artifacts: [finalized.artifact, duplicate], overlay });
    assert.equal(blocked.manifest.status, "CONFLICT_BLOCKED");
    assert.match(blocked.manifest.blockedReason, /overlap/);
    assert.equal(blocked.manifest.recovery.mode, "preserved-worktree");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("finalizer and integrator preserve NUL-delimited paths with spaces and Unicode", async () => {
  const root = mkdtempSync(join(tmpdir(), "orchestration-nul-paths-"));
  try {
    git(root, ["init", "-b", "main"]);
    writeFileSync(join(root, "package.json"), JSON.stringify({ packageManager: "npm@10", scripts: {} }), "utf8");
    writeFileSync(join(root, "package-lock.json"), "{}", "utf8");
    mkdirSync(join(root, "src"));
    const changedPath = "src/мій файл.mjs";
    writeFileSync(join(root, changedPath), "export const value = 1;\n", "utf8");
    git(root, ["add", "."]); git(root, ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "base"]);
    const { overlay, path } = await generateProjectOverlay({ repository: root, baseRef: "main" });
    const worktree = join(root, "runtime", "worktrees", "unicode writer");
    mkdirSync(join(root, "runtime", "worktrees"), { recursive: true });
    git(root, ["worktree", "add", "-b", "swarm/unicode-writer", worktree, overlay.repository.baseSha]);
    writeFileSync(join(worktree, changedPath), "export const value = 2;\n", "utf8");
    const finalized = await new WorktreeFinalizer({ repository: root, generatedDir: "docs/orchestration-generated" }).finalize({ task: { id: "unicode-writer", role: "backend", allowedPaths: [changedPath], dependencies: [] }, worktree, branch: "swarm/unicode-writer", overlay, overlayPath: path });
    assert.deepEqual(finalized.artifact.changedPaths, [changedPath]);
    const integration = await new Integrator({ repository: root, runtimeDir: join(root, "runtime"), generatedDir: "docs/orchestration-generated" }).integrate({ artifacts: [finalized.artifact], overlay });
    assert.equal(integration.manifest.status, "candidate_ready");
    assert.equal(git(integration.manifest.worktree, ["show", `HEAD:${changedPath}`]), "export const value = 2;");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("integrator applies a chained remediation artifact once after its predecessor", async () => {
  const root = mkdtempSync(join(tmpdir(), "orchestration-artifact-chain-"));
  try {
    git(root, ["init", "-b", "main"]); writeFileSync(join(root, "package.json"), JSON.stringify({ packageManager: "npm@10", scripts: {} })); writeFileSync(join(root, "package-lock.json"), "{}"); mkdirSync(join(root, "src")); writeFileSync(join(root, "src", "value.mjs"), "export const value = 1;\n");
    git(root, ["add", "."]); git(root, ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "base"]);
    const { overlay, path } = await generateProjectOverlay({ repository: root, baseRef: "main" }); const finalizer = new WorktreeFinalizer({ repository: root, generatedDir: "docs/orchestration-generated" });
    const firstWorktree = join(root, "first"); git(root, ["worktree", "add", "-b", "swarm/first", firstWorktree, overlay.repository.baseSha]); writeFileSync(join(firstWorktree, "src", "value.mjs"), "export const value = 2;\n");
    const first = await finalizer.finalize({ task: { id: "writer", role: "backend", allowedPaths: ["src"], dependencies: [] }, worktree: firstWorktree, branch: "swarm/first", overlay, overlayPath: path });
    const remWorktree = join(root, "remediation"); git(root, ["worktree", "add", "-b", "swarm/remediation", remWorktree, first.artifact.headSha]); writeFileSync(join(remWorktree, "src", "value.mjs"), "export const value = 2; // remediated\n");
    const remediation = await finalizer.finalize({ task: { id: "remediation", role: "backend", allowedPaths: ["src"], dependencies: ["qa"], artifactDependencies: ["writer"], artifactBaseSha: first.artifact.headSha }, worktree: remWorktree, branch: "swarm/remediation", overlay, overlayPath: path });
    assert.equal(remediation.artifact.baseSha, first.artifact.headSha); assert.deepEqual(remediation.artifact.dependencies, ["writer"]);
    const integration = await new Integrator({ repository: root, runtimeDir: join(root, "runtime"), generatedDir: "docs/orchestration-generated" }).integrate({ artifacts: [first.artifact, remediation.artifact], overlay });
    assert.equal(integration.manifest.status, "candidate_ready"); assert.deepEqual(integration.manifest.appliedArtifacts, ["writer", "remediation"]); assert.equal(git(integration.manifest.worktree, ["log", "--format=%s", "-2"]), "swarm: finalize remediation\nswarm: finalize writer");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
