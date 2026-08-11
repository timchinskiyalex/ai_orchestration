import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { generateProjectOverlay } from "../src/project-overlay.mjs";

const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
test("ProjectOverlay discovery is evidence-backed and does not read sensitive file values", async () => {
  const root = mkdtempSync(join(tmpdir(), "orchestration-overlay-"));
  try {
    git(root, ["init", "-b", "main"]); mkdirSync(join(root, ".github", "workflows"), { recursive: true }); mkdirSync(join(root, "packages", "api"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", packageManager: "pnpm@9.0.0", scripts: { test: "node --test", lint: "node --check src/index.mjs" }, workspaces: ["packages/*"] }), "utf8");
    writeFileSync(join(root, "package-lock.json"), "{}", "utf8"); writeFileSync(join(root, "tsconfig.json"), "{}", "utf8");
    writeFileSync(join(root, ".env.local"), "PRIVATE_VALUE=must-not-appear", "utf8"); writeFileSync(join(root, "AGENTS.md"), "Scoped instructions", "utf8");
    writeFileSync(join(root, ".github", "workflows", "ci.yml"), "name: CI\npermissions: read-all\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm run test\n", "utf8");
    git(root, ["add", "."]); git(root, ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "base"]);
    const { overlay, path } = await generateProjectOverlay({ repository: root, baseRef: "main" });
    assert.equal(path.endsWith("project-overlay.v1.json"), true);
    assert.equal(overlay.repository.clean, true);
    assert.equal(overlay.stack.typescript, true);
    assert.equal(overlay.stack.packageManager.name, "pnpm");
    assert.match(overlay.verificationCommands[0].args.at(-1), /pnpm run/);
    assert.equal(overlay.sensitivePaths[0].contentRead, false);
    assert.equal(JSON.stringify(overlay).includes("must-not-appear"), false);
    assert.equal(overlay.workflows[0].requiredChecks, "unknown");
    assert.equal(overlay.agents[0].scope, ".");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
