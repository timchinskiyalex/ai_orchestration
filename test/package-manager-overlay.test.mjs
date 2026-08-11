import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { generateProjectOverlay } from "../src/project-overlay.mjs";

const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
for (const [manager, lockfile] of [["npm", "package-lock.json"], ["pnpm", "pnpm-lock.yaml"], ["yarn", "yarn.lock"]]) test(`ProjectOverlay emits declared ${manager} verification command`, async () => {
  const root = mkdtempSync(join(tmpdir(), `overlay-${manager}-`));
  try {
    git(root, ["init", "-b", "main"]); writeFileSync(join(root, "package.json"), JSON.stringify({ packageManager: `${manager}@1.0.0`, scripts: { test: "node --test" } }), "utf8"); writeFileSync(join(root, lockfile), "", "utf8");
    git(root, ["add", "."]); git(root, ["-c", "user.name=t", "-c", "user.email=t@e", "commit", "-m", "base"]);
    const { overlay } = await generateProjectOverlay({ repository: root, baseRef: "main" });
    assert.equal(overlay.stack.packageManager.name, manager);
    assert.match(overlay.verificationCommands[0].args.at(-1), new RegExp(`${manager} run test`));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
