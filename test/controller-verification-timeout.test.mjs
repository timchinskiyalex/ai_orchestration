import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateProjectOverlay } from "../src/project-overlay.mjs";
import { WorktreeFinalizer } from "../src/worktree-finalizer.mjs";

const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

test("controller verification timeout preserves the worktree and yields a controlled finalization failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "verification-timeout-"));
  try {
    git(root, ["init", "-b", "main"]); mkdirSync(join(root, "src")); writeFileSync(join(root, "package.json"), JSON.stringify({ packageManager: "npm@10", scripts: { test: "node --test" } })); writeFileSync(join(root, "package-lock.json"), "{}"); writeFileSync(join(root, "src", "value.mjs"), "export const value = 1;\n"); git(root, ["add", "."]); git(root, ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "base"]);
    const { overlay, path } = await generateProjectOverlay({ repository: root, baseRef: "main" }); const worktree = join(root, "runtime", "writer"); mkdirSync(join(root, "runtime"), { recursive: true }); git(root, ["worktree", "add", "-b", "swarm/timeout", worktree, overlay.repository.baseSha]); writeFileSync(join(worktree, "src", "value.mjs"), "export const value = 2;\n");
    const timeoutRunner = async () => { const error = new Error("Process timed out after 1ms: npm"); error.timedOut = true; error.pid = 17; error.termination = { command: "taskkill" }; throw error; };
    const finalizer = new WorktreeFinalizer({ repository: root, generatedDir: "docs/orchestration-generated", processRunner: timeoutRunner });
    await assert.rejects(finalizer.finalize({ task: { id: "writer", role: "backend", allowedPaths: ["src"], dependencies: [] }, worktree, branch: "swarm/timeout", overlay, overlayPath: path }), /Verification failed: package-script:test/);
    assert.match(git(worktree, ["status", "--porcelain"]), /src\/value\.mjs/, "the dirty worktree is retained for bounded remediation or failure diagnostics");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
