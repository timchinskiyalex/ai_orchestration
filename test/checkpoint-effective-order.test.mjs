import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { generateProjectOverlay } from "../src/project-overlay.mjs";
import { WorktreeFinalizer } from "../src/worktree-finalizer.mjs";
import { Integrator } from "../src/integrator.mjs";

const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const barrier = ({ id, baseSha, inputArtifacts }) => ({ schemaVersion: 1, kind: "IntegrationBarrier", id, deliveryRunId: "run", blueprintId: "blueprint", wave: 1, baseSha, inputArtifacts: inputArtifacts.map(({ taskId, headSha }) => ({ artifactId: taskId, headSha })), status: "pending", createdAt: "2026-01-01T00:00:00.000Z" });

async function contextualFanIn() {
  const root = mkdtempSync(join(tmpdir(), "checkpoint-effective-order-"));
  git(root, ["init", "-b", "main"]); writeFileSync(join(root, "package.json"), JSON.stringify({ packageManager: "npm@10", scripts: {} })); writeFileSync(join(root, "package-lock.json"), "{}"); mkdirSync(join(root, "src")); writeFileSync(join(root, "src", "base.mjs"), "export const base = true;\n"); git(root, ["add", "."]); git(root, ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "base"]);
  const { overlay, path } = await generateProjectOverlay({ repository: root, baseRef: "main" }); const finalizer = new WorktreeFinalizer({ repository: root, generatedDir: "docs/orchestration-generated" });
  const finalize = async (id, baseSha, change) => {
    const worktree = join(root, id); git(root, ["worktree", "add", "-b", `swarm/${id}`, worktree, baseSha]); change(worktree);
    return (await finalizer.finalize({ task: { id, role: "backend", allowedPaths: ["src"], dependencies: [], artifactDependencies: [], artifactBaseSha: baseSha }, worktree, branch: `swarm/${id}`, overlay, overlayPath: path })).artifact;
  };
  const a = await finalize("writer-a", overlay.repository.baseSha, (worktree) => writeFileSync(join(worktree, "src", "a.mjs"), "export const a = true;\n"));
  const c = await finalize("writer-c", overlay.repository.baseSha, (worktree) => writeFileSync(join(worktree, "src", "context.mjs"), "export const context = 'created-by-c';\n"));
  const integrator = new Integrator({ repository: root, runtimeDir: join(root, "runtime"), generatedDir: "docs/orchestration-generated" });
  const firstBarrier = await integrator.integrateBarrier({ barrier: barrier({ id: "local-m", baseSha: overlay.repository.baseSha, inputArtifacts: [a, c] }), artifacts: [a, c], effectiveArtifacts: [a, c], effectiveLineage: [{ kind: "artifact", id: a.taskId, sha: a.headSha }, { kind: "artifact", id: c.taskId, sha: c.headSha }], overlay });
  assert.equal(firstBarrier.status, "passed");
  const b = await finalize("writer-b", firstBarrier.outputSha, (worktree) => writeFileSync(join(worktree, "src", "context.mjs"), "export const context = 'modified-by-b';\n"));
  const d = await finalize("writer-d", overlay.repository.baseSha, (worktree) => writeFileSync(join(worktree, "src", "d.mjs"), "export const d = true;\n"));
  const lineage = [{ kind: "artifact", id: a.taskId, sha: a.headSha }, { kind: "artifact", id: c.taskId, sha: c.headSha }, { kind: "checkpoint", id: "local-m", sha: firstBarrier.outputSha }, { kind: "artifact", id: b.taskId, sha: b.headSha }, { kind: "artifact", id: d.taskId, sha: d.headSha }];
  return { root, overlay, integrator, a, b, c, d, lineage, checkpointSha: firstBarrier.outputSha };
}

test("later barrier preserves a previous local checkpoint's effective fan-in order", async () => {
  const fixture = await contextualFanIn();
  try {
    const result = await fixture.integrator.integrateBarrier({ barrier: barrier({ id: "nested", baseSha: fixture.overlay.repository.baseSha, inputArtifacts: [fixture.b, fixture.d] }), artifacts: [fixture.b, fixture.d], effectiveArtifacts: [fixture.b, fixture.d, fixture.c, fixture.a], effectiveLineage: fixture.lineage, allowedBaseShas: [fixture.checkpointSha], overlay: fixture.overlay });
    assert.equal(result.status, "passed");
    assert.equal(git(result.worktree, ["show", "HEAD:src/context.mjs"]), "export const context = 'modified-by-b';");
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("integrator rejects incomplete, duplicate, inconsistent, and non-topological effective lineage", async () => {
  const fixture = await contextualFanIn();
  try {
    const integrate = (artifacts, lineage) => fixture.integrator.integrate({ artifacts, lineage, overlay: fixture.overlay, baseSha: fixture.overlay.repository.baseSha, allowedBaseShas: [fixture.checkpointSha] });
    await assert.rejects(() => integrate([fixture.a, fixture.c, fixture.b, fixture.d], fixture.lineage.filter((node) => node.id !== fixture.b.taskId)), /missing artifacts/);
    await assert.rejects(() => integrate([fixture.a, fixture.c, fixture.b, fixture.d], [...fixture.lineage, fixture.lineage[0]]), /duplicate/);
    await assert.rejects(() => integrate([fixture.a, fixture.c, fixture.b, fixture.d], fixture.lineage.map((node) => node.id === fixture.b.taskId ? { ...node, sha: fixture.a.headSha } : node)), /inconsistent/);
    const chainedB = { ...fixture.b, parentArtifactId: fixture.c.taskId, dependencies: [fixture.c.taskId] };
    await assert.rejects(() => integrate([fixture.a, fixture.c, chainedB, fixture.d], [fixture.lineage[0], fixture.lineage[2], { kind: "artifact", id: chainedB.taskId, sha: chainedB.headSha }, fixture.lineage[1], fixture.lineage[4]]), /not topological/);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});
