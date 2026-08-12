import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SwarmRouter } from "../src/router.mjs";

function config(root, requireCi = true) {
  const roles = Object.fromEntries(["bootstrap", "planner", "backend", "frontend", "database", "qa", "security", "devops"].map((role) => [role, { sandbox: "read-only", approvalPolicy: "never", tokenBudget: 100, usesWorktree: false }]));
  return { repository: root, runtimeDir: join(root, "runtime"), baseRef: "main", model: "fake", project: { name: "test", documentationDir: "docs/in", generatedDir: "docs/out" }, router: { maxConcurrentTasks: 1, maxChildrenPerTask: 1, maxDelegationDepth: 1, maxPlanTasks: 1, defaultParentBudget: 100, turnTimeoutMs: 1000, approvalMode: "deny" }, autonomy: { mode: "autonomous", autoPush: true, autoCreatePullRequest: true, autoMerge: true }, budget: { weeklyTokenLimit: 1000, weeklyWindowDays: 7 }, quota: { throttleAtUsedPercent: 90 }, delivery: {}, remote: { enabled: true, remoteName: "origin", allowedRemotes: ["origin"], candidateBranchPrefix: "swarm/candidate/", requireCi, mergeMethod: "merge" }, roles };
}
const integration = { path: "docs/out/integration-manifests/manifest.v1.json", manifest: { id: "manifest", schemaVersion: 1, status: "candidate_ready", branch: "swarm/candidate/test", candidateSha: "a".repeat(40), localVerification: { status: "passed" } } };

test("hand-built integration manifests cannot publish or merge", async () => {
  const root = mkdtempSync(join(tmpdir(), "candidate-publish-")); const router = new SwarmRouter(config(root)); let merged = 0;
  try {
    const result = await router.publishCandidate(integration, { mergeAdapter: { async merge() { merged += 1; return { status: "merged" }; } } });
    assert.equal(result.terminalState, "conflict_blocked"); assert.equal(merged, 0);
  } finally { router.close(); rmSync(root, { recursive: true, force: true }); }
});

test("legacy requireCi false never allows final merge without persisted acceptance", async () => {
  const root = mkdtempSync(join(tmpdir(), "candidate-ci-")); const router = new SwarmRouter(config(root, false)); let merged = 0;
  try {
    const result = await router.publishCandidate(integration, { mergeAdapter: { async merge() { merged += 1; return { status: "merged" }; } } });
    assert.equal(result.terminalState, "conflict_blocked"); assert.equal(merged, 0);
  } finally { router.close(); rmSync(root, { recursive: true, force: true }); }
});
