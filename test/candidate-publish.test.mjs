import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SwarmRouter } from "../src/router.mjs";

function config(root) {
  const roles = Object.fromEntries(["bootstrap", "planner", "backend", "frontend", "database", "qa", "security", "devops"].map((role) => [role, { sandbox: role === "backend" ? "workspace-write" : "read-only", approvalPolicy: "never", tokenBudget: 100, usesWorktree: role === "backend" }]));
  return { repository: root, runtimeDir: join(root, "runtime"), baseRef: "main", model: "fake", project: { name: "test", documentationDir: "docs/in", generatedDir: "docs/out" }, router: { maxConcurrentTasks: 10, maxChildrenPerTask: 20, maxDelegationDepth: 4, maxPlanTasks: 12, defaultParentBudget: 1000, turnTimeoutMs: 1000, approvalMode: "deny" }, budget: { weeklyTokenLimit: 10000, weeklyWindowDays: 7 }, quota: { throttleAtUsedPercent: 90, throttleWhenUnavailable: false }, delivery: { maxRemediationRounds: 2 }, remote: { enabled: true, remoteName: "origin", allowedRemotes: ["origin"], candidateBranchPrefix: "swarm/candidate/", requireCi: true }, roles };
}
const integration = { manifest: { status: "awaiting_human_merge", branch: "swarm/candidate/test", candidateSha: "a".repeat(40), humanMergeGate: { required: true } } };

test("candidate publishing is idempotent and requires configured CI to pass", async () => {
  const root = mkdtempSync(join(tmpdir(), "candidate-publish-")); const router = new SwarmRouter(config(root)); let pushes = 0;
  try {
    const git = { async pushCandidate() { pushes += 1; return { status: "pushed", branch: integration.manifest.branch, sha: integration.manifest.candidateSha }; } };
    const missingCi = await router.publishCandidate(integration, { confirmRemotePush: true, remoteGitAdapter: git });
    assert.equal(missingCi.terminalState, "awaiting_human"); assert.equal(pushes, 1);
    const ready = await router.publishCandidate(integration, { confirmRemotePush: true, remoteGitAdapter: git, remoteCiAdapter: { async verify() { return { status: "passed" }; } } });
    assert.equal(ready.terminalState, "completed_candidate_ready"); assert.equal(pushes, 1, "restart/idempotency must not push the same SHA twice");
  } finally { router.close(); rmSync(root, { recursive: true, force: true }); }
});
