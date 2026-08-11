import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { generateProjectOverlay, projectOverlayExecutionSnapshot } from "../src/project-overlay.mjs";
import { formatTaskPrompt, SwarmRouter } from "../src/router.mjs";

const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

function config(root) {
  const roles = Object.fromEntries(["bootstrap", "planner", "backend", "frontend", "database", "qa", "security", "devops"].map((role) => [role, {
    sandbox: "read-only", approvalPolicy: "never", tokenBudget: 100, maxAttempts: 1, usesWorktree: false
  }]));
  return {
    repository: root, runtimeDir: join(root, "runtime"), baseRef: "main", model: "test",
    project: { name: "test", documentationDir: "docs/orchestration-input", generatedDir: "docs/orchestration-generated" },
    router: { maxConcurrentTasks: 1, maxChildrenPerTask: 2, maxDelegationDepth: 2, maxPlanTasks: 2, defaultParentBudget: 1000, turnTimeoutMs: 1000, approvalMode: "deny" },
    budget: { weeklyTokenLimit: 1000, weeklyWindowDays: 7 }, quota: { throttleAtUsedPercent: 90, throttleWhenUnavailable: false }, roles
  };
}

function fixtureOverlay() {
  return {
    schemaVersion: 1,
    repository: { baseSha: "base-sha" },
    stack: { adapter: "node", adapterSupport: "production-ready", node: true, typescript: true, packageManager: { name: "npm", version: "10", source: "package.json#packageManager", confidence: "declared" } },
    verificationCommands: [{ id: "package-script:test", executable: "npm", args: ["run", "test"], confidence: "declared" }],
    modules: { backend: { present: true, paths: ["src"], confidence: "inferred" } },
    agents: [{ path: "AGENTS.md", scope: ".", confidence: "verified" }],
    pathPolicies: { denyWrite: ["secrets/token.pem"], contextExclude: ["secrets/token.pem"], approvalRequired: [".github/workflows"], generatedDoNotEdit: ["generated"] },
    sensitivePaths: [{ path: "secrets/token.pem", contentRead: false }],
    evidenceLedger: [
      { path: "secrets/token.pem", parser: "name-pattern", value: "SUPER_SECRET_VALUE", confidence: "verified" },
      { path: "package.json", parser: "json", value: { scripts: ["test"] }, confidence: "declared" }
    ]
  };
}

test("worker prompt carries a sanitized controller Overlay snapshot", () => {
  const snapshot = projectOverlayExecutionSnapshot(fixtureOverlay());
  const prompt = formatTaskPrompt({
    task: { id: "backend-1", title: "Change value", prompt: "Update the value", allowedPaths: ["src/value.mjs"], acceptanceChecks: ["npm test"] },
    worktree: "C:/tmp/writer", project: { documentationDir: "docs/in", generatedDir: "docs/orchestration-generated" }, overlaySnapshot: snapshot
  });
  assert.match(prompt, /Controller-provided sanitized ProjectOverlay execution snapshot/);
  assert.match(prompt, /base-sha/);
  assert.match(prompt, /package-script:test/);
  assert.match(prompt, /AGENTS\.md/);
  assert.match(prompt, /approvalRequired/);
  assert.doesNotMatch(prompt, /ProjectOverlay: .*project-overlay\.v1\.json/);
  assert.doesNotMatch(prompt, /secrets\/token\.pem|SUPER_SECRET_VALUE|denyWrite|contextExclude|evidenceLedger/);
});

test("worker prompt does not direct a repository without imported docs to read documentation", () => {
  const prompt = formatTaskPrompt({
    task: { id: "backend-no-docs", title: "Change value", prompt: "Update the value", allowedPaths: ["src/value.mjs"], acceptanceChecks: [] },
    worktree: "C:/tmp/writer", project: { documentationDir: "docs/orchestration-input", generatedDir: "docs/orchestration-generated" },
    overlaySnapshot: projectOverlayExecutionSnapshot(fixtureOverlay()), documentationAvailable: false
  });
  assert.doesNotMatch(prompt, /Project documentation:/);
  assert.match(prompt, /Project documentation has not been imported/);
  assert.match(prompt, /Do not assume docs\/orchestration-input exists/);
});

test("single-worker smoke context uses the prompt snapshot, not an Overlay file in the writer worktree", async () => {
  const root = mkdtempSync(join(tmpdir(), "overlay-worker-context-"));
  try {
    git(root, ["init", "-b", "main"]);
    writeFileSync(join(root, "package.json"), JSON.stringify({ packageManager: "npm@10", scripts: { test: "node --test" } }), "utf8");
    writeFileSync(join(root, "package-lock.json"), "{}", "utf8");
    mkdirSync(join(root, "src")); writeFileSync(join(root, "src", "value.mjs"), "export const value = 1;\n", "utf8");
    git(root, ["add", "."]); git(root, ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "base"]);
    const { overlay } = await generateProjectOverlay({ repository: root, baseRef: "main" });
    const writer = join(root, "runtime", "worktrees", "writer");
    mkdirSync(join(root, "runtime", "worktrees"), { recursive: true });
    git(root, ["worktree", "add", "-b", "swarm/writer", writer, overlay.repository.baseSha]);
    const prompt = formatTaskPrompt({
      task: { id: "e2e-backend", title: "Set value", prompt: "Change only src/value.mjs", allowedPaths: ["src/value.mjs"], acceptanceChecks: ["npm test"] },
      worktree: writer, project: config(root).project, overlaySnapshot: projectOverlayExecutionSnapshot(overlay)
    });
    assert.equal(existsSync(join(writer, "docs", "orchestration-generated", "project-overlay.v1.json")), false);
    assert.match(prompt, new RegExp(overlay.repository.baseSha));
    assert.doesNotMatch(prompt, /ProjectOverlay: .*project-overlay\.v1\.json/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("missing Overlay blocks an engineering worker before the App Server client starts", async () => {
  const root = mkdtempSync(join(tmpdir(), "overlay-required-"));
  const router = new SwarmRouter(config(root));
  try {
    git(root, ["init", "-b", "main"]);
    writeFileSync(join(root, "package.json"), JSON.stringify({ packageManager: "npm@10" }), "utf8");
    writeFileSync(join(root, "package-lock.json"), "{}", "utf8");
    git(root, ["add", "."]); git(root, ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "base"]);
    router.enqueue({ role: "backend", title: "Blocked", prompt: "Do not start", allowedPaths: ["src/value.mjs"] });
    await assert.rejects(router.runUntilIdle(), /Missing ProjectOverlay/);
  } finally { router.close(); rmSync(root, { recursive: true, force: true }); }
});
