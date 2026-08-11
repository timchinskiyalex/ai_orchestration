import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SwarmRouter } from "../src/router.mjs";
import { RemoteAdapterError } from "../src/remote-adapters.mjs";

function config(root) {
  const roles = Object.fromEntries(["bootstrap", "planner", "backend", "frontend", "database", "qa", "security", "devops"].map((role) => [role, { sandbox: role === "backend" ? "workspace-write" : "read-only", approvalPolicy: "never", tokenBudget: 100, usesWorktree: role === "backend" }]));
  return { repository: root, runtimeDir: join(root, "runtime"), baseRef: "main", model: "fake", project: { name: "test", documentationDir: "docs/in", generatedDir: "docs/out" }, router: { maxConcurrentTasks: 10, maxChildrenPerTask: 20, maxDelegationDepth: 4, maxPlanTasks: 12, defaultParentBudget: 1000, turnTimeoutMs: 1000, approvalMode: "deny" }, autonomy: { mode: "autonomous", autoApproveWorkflowGates: true, autoRemediate: true, autoPush: true, autoCreatePullRequest: true, autoMerge: true, maxRemediationRounds: 3 }, budget: { weeklyTokenLimit: 10000, weeklyWindowDays: 7 }, quota: { throttleAtUsedPercent: 90, throttleWhenUnavailable: false }, delivery: { maxRemediationRounds: 3 }, remote: { enabled: true, remoteName: "origin", allowedRemotes: ["origin"], candidateBranchPrefix: "swarm/candidate/", requireCi: true, mergeMethod: "merge" }, roles };
}
const integration = { manifest: { status: "candidate_ready", branch: "swarm/candidate/test", candidateSha: "a".repeat(40), localVerification: { status: "passed" } } };

test("candidate push, PR, remote CI, and merge are restart-idempotent", async () => {
  const root = mkdtempSync(join(tmpdir(), "candidate-publish-")); const router = new SwarmRouter(config(root)); const calls = { push: 0, pr: 0, ci: 0, merge: 0 };
  try {
    const adapters = {
      remoteGitAdapter: { async pushCandidate() { calls.push += 1; return { status: "pushed", branch: integration.manifest.branch, sha: integration.manifest.candidateSha }; } },
      pullRequestAdapter: { async ensurePullRequest() { calls.pr += 1; return { status: "open", number: 42, url: "https://example.test/pr/42" }; } },
      remoteCiAdapter: { async waitForChecks() { calls.ci += 1; return { status: "passed", checkRuns: [{ name: "test", status: "completed", conclusion: "success" }] }; } },
      mergeAdapter: { async merge() { calls.merge += 1; return { status: "merged", mainSha: "b".repeat(40), mergeSha: "b".repeat(40) }; } }
    };
    const first = await router.publishCandidate(integration, adapters);
    assert.equal(first.terminalState, "completed_merged");
    const restart = await router.publishCandidate(integration, adapters);
    assert.equal(restart.terminalState, "completed_merged");
    assert.deepEqual(calls, { push: 1, pr: 1, ci: 1, merge: 1 });
  } finally { router.close(); rmSync(root, { recursive: true, force: true }); }
});

test("failed required CI is a terminal blocker and is never merged", async () => {
  const root = mkdtempSync(join(tmpdir(), "candidate-ci-")); const router = new SwarmRouter(config(root)); let merged = 0;
  try {
    const result = await router.publishCandidate(integration, {
      remoteGitAdapter: { async pushCandidate() { return { status: "pushed" }; } },
      pullRequestAdapter: { async ensurePullRequest() { return { status: "open", number: 43, url: "https://example.test/pr/43" }; } },
      remoteCiAdapter: { async waitForChecks() { return { status: "failed", reason: "tests failed", checkRuns: [{ name: "test", status: "completed", conclusion: "failure" }] }; } },
      mergeAdapter: { async merge() { merged += 1; return { status: "merged", mainSha: "b".repeat(40) }; } }
    });
    assert.equal(result.terminalState, "blocked_ci"); assert.equal(merged, 0);
  } finally { router.close(); rmSync(root, { recursive: true, force: true }); }
});

test("branch-protection merge refusal is terminal and preserves the PR record", async () => {
  const root = mkdtempSync(join(tmpdir(), "candidate-protection-")); const router = new SwarmRouter(config(root));
  try {
    const result = await router.publishCandidate(integration, {
      remoteGitAdapter: { async pushCandidate() { return { status: "pushed" }; } },
      pullRequestAdapter: { async ensurePullRequest() { return { status: "open", number: 44, url: "https://example.test/pr/44" }; } },
      remoteCiAdapter: { async waitForChecks() { return { status: "passed" }; } },
      mergeAdapter: { async merge() { throw new RemoteAdapterError("branch_protection", "required review has not passed"); } }
    });
    assert.equal(result.terminalState, "blocked_branch_protection"); assert.equal(result.stage, "merge");
  } finally { router.close(); rmSync(root, { recursive: true, force: true }); }
});
