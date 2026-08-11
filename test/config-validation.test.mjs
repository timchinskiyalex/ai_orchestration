import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.mjs";

function config(overrides = {}) {
  const roles = Object.fromEntries(["bootstrap", "planner", "backend", "frontend", "database", "qa", "security", "devops"].map((role) => [role, { sandbox: role === "backend" ? "workspace-write" : "read-only", approvalPolicy: "never", tokenBudget: 10, usesWorktree: role === "backend" }]));
  return { repository: ".", runtimeDir: "./runtime", project: { documentationDir: "docs/in", generatedDir: "docs/out" }, roles, ...overrides };
}
function load(value) { const root = mkdtempSync(join(tmpdir(), "config-validation-")); const path = join(root, "config.json"); writeFileSync(path, JSON.stringify(value)); try { return loadConfig(path); } finally { rmSync(root, { recursive: true, force: true }); } }
test("config rejects unsafe role capabilities and project paths", () => {
  assert.throws(() => load(config({ roles: { ...config().roles, backend: { ...config().roles.backend, usesWorktree: false } } })), /workspace-write requires/);
  assert.throws(() => load(config({ project: { documentationDir: "../escape", generatedDir: "docs/out" } })), /normalized relative/);
  assert.throws(() => load(config({ project: { documentationDir: "docs/in", generatedDir: "C:/escape" } })), /normalized relative/);
  assert.throws(() => load(config({ roles: { ...config().roles, qa: { ...config().roles.qa, approvalPolicy: "on-request" } } })), /approvalPolicy/);
});

test("new config defaults to fully autonomous delivery and retains explicit manual mode", () => {
  const autonomous = load(config());
  assert.equal(autonomous.autonomy.mode, "autonomous");
  assert.equal(autonomous.autonomy.autoMerge, true);
  assert.equal(autonomous.delivery.maxRemediationRounds, 3);
  const manual = load(config({ autonomy: { mode: "manual", autoApproveWorkflowGates: false, autoRemediate: false, autoPush: false, autoCreatePullRequest: false, autoMerge: false, maxRemediationRounds: 1 }, delivery: { maxRemediationRounds: 1 } }));
  assert.equal(manual.autonomy.mode, "manual");
  assert.throws(() => load(config({ autonomy: { mode: "autonomous", autoApproveWorkflowGates: false } })), /requires all autonomy/);
});
