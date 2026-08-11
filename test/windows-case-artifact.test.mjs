import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateProjectOverlay } from "../src/project-overlay.mjs";
import { WorktreeFinalizer } from "../src/worktree-finalizer.mjs";

const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const passingRunner = async () => ({ pid: 1, stdout: "", stderr: "", code: 0, signal: null });

test("WorkerArtifact uses Git-canonical path casing after a Windows agent spelling variant", { skip: process.platform === "win32" ? false : "Windows-specific canonical casing" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "artifact-case-"));
  try {
    git(root, ["init", "-b", "main"]); mkdirSync(join(root, "backend", "src", "Backend.Api"), { recursive: true }); writeFileSync(join(root, "package.json"), JSON.stringify({ packageManager: "npm@10", scripts: { test: "node --test" } })); writeFileSync(join(root, "package-lock.json"), "{}"); writeFileSync(join(root, "backend", "src", "Backend.Api", "Program.cs"), "// base\n"); git(root, ["add", "."]); git(root, ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "base"]);
    const { overlay, path } = await generateProjectOverlay({ repository: root, baseRef: "main" }); const worktree = join(root, "runtime", "writer"); mkdirSync(join(root, "runtime"), { recursive: true }); git(root, ["worktree", "add", "-b", "swarm/case", worktree, overlay.repository.baseSha]);
    writeFileSync(join(worktree, "backend", "src", "backend.Api", "Marker.cs"), "// marker\n");
    const artifact = (await new WorktreeFinalizer({ repository: root, generatedDir: "docs/orchestration-generated", processRunner: passingRunner }).finalize({ task: { id: "case", role: "backend", allowedPaths: ["backend"], dependencies: [] }, worktree, branch: "swarm/case", overlay, overlayPath: path })).artifact;
    const canonical = git(root, ["diff", "--name-only", artifact.baseSha, artifact.headSha, "--"]);
    assert.deepEqual(artifact.changedPaths, [canonical]);
    assert.match(canonical, /backend\/src\/Backend\.Api\/Marker\.cs$/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
