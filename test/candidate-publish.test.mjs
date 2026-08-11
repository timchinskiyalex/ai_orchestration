import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SwarmRouter } from "../src/router.mjs";
import { GitHubCiAdapter, RemoteAdapterError } from "../src/remote-adapters.mjs";

function config(root) {
  const roles = Object.fromEntries(["bootstrap", "planner", "backend", "frontend", "database", "qa", "security", "devops"].map((role) => [role, { sandbox: role === "backend" ? "workspace-write" : "read-only", approvalPolicy: "never", tokenBudget: 100, usesWorktree: role === "backend" }]));
  return { repository: root, runtimeDir: join(root, "runtime"), baseRef: "main", model: "fake", project: { name: "test", documentationDir: "docs/in", generatedDir: "docs/out" }, router: { maxConcurrentTasks: 10, maxChildrenPerTask: 20, maxDelegationDepth: 4, maxPlanTasks: 12, defaultParentBudget: 1000, turnTimeoutMs: 1000, approvalMode: "deny" }, autonomy: { mode: "autonomous", autoApproveWorkflowGates: true, autoRemediate: true, autoPush: true, autoCreatePullRequest: true, autoMerge: true, maxRemediationRounds: 3 }, budget: { weeklyTokenLimit: 10000, weeklyWindowDays: 7 }, quota: { throttleAtUsedPercent: 90, throttleWhenUnavailable: false }, delivery: { maxRemediationRounds: 3 }, remote: { enabled: true, remoteName: "origin", allowedRemotes: ["origin"], candidateBranchPrefix: "swarm/candidate/", requireCi: true, mergeMethod: "merge" }, roles };
}
const integration = { manifest: { status: "candidate_ready", branch: "swarm/candidate/test", candidateSha: "a".repeat(40), localVerification: { status: "passed" } } };

test("candidate push, PR, remote CI, and merge are restart-idempotent", async () => {
  const root = mkdtempSync(join(tmpdir(), "candidate-publish-")); const router = new SwarmRouter(config(root)); const calls = { push: 0, pr: 0, ci: 0, merge: 0 };
  try {
    const adapters = {
      remoteGitAdapter: { async pushCandidate() { calls.push += 1; return { status: "pushed", branch: integration.manifest.branch, sha: integration.manifest.candidateSha, verifiedSha: integration.manifest.candidateSha }; } },
      pullRequestAdapter: { async ensurePullRequest() { calls.pr += 1; return { status: "open", number: 42, url: "https://example.test/pr/42", headSha: integration.manifest.candidateSha }; } },
      remoteCiAdapter: { async waitForChecks() { calls.ci += 1; return { status: "passed", checkRuns: [{ name: "test", status: "completed", conclusion: "success" }] }; } },
      mergeAdapter: { async merge() { calls.merge += 1; return { status: "merged", mainSha: "b".repeat(40), mergeSha: "b".repeat(40), targetVerified: true }; } }
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
      remoteGitAdapter: { async pushCandidate() { return { status: "pushed", verifiedSha: integration.manifest.candidateSha }; } },
      pullRequestAdapter: { async ensurePullRequest() { return { status: "open", number: 43, url: "https://example.test/pr/43", headSha: integration.manifest.candidateSha }; } },
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
      remoteGitAdapter: { async pushCandidate() { return { status: "pushed", verifiedSha: integration.manifest.candidateSha }; } },
      pullRequestAdapter: { async ensurePullRequest() { return { status: "open", number: 44, url: "https://example.test/pr/44", headSha: integration.manifest.candidateSha }; } },
      remoteCiAdapter: { async waitForChecks() { return { status: "passed" }; } },
      mergeAdapter: { async merge() { throw new RemoteAdapterError("branch_protection", "required review has not passed"); } }
    });
    assert.equal(result.terminalState, "blocked_branch_protection"); assert.equal(result.stage, "merge");
  } finally { router.close(); rmSync(root, { recursive: true, force: true }); }
});

test("only all required candidate-SHA CI contexts permit merge", async () => {
  const scenarios = [
    { name: "green unrelated", runs: [{ name: "lint", status: "completed", conclusion: "success", head_sha: "a".repeat(40) }], expected: "blocked_ci" }, { name: "missing", runs: [], expected: "blocked_ci" }, { name: "pending", runs: [{ name: "build", status: "in_progress", conclusion: null, head_sha: "a".repeat(40) }], expected: "blocked_ci" }, { name: "failed", runs: [{ name: "build", status: "completed", conclusion: "failure", head_sha: "a".repeat(40) }], expected: "blocked_ci" }, { name: "green required", runs: [{ name: "build", status: "completed", conclusion: "success", head_sha: "a".repeat(40) }], expected: "completed_merged" }
  ];
  for (const scenario of scenarios) {
    const root = mkdtempSync(join(tmpdir(), "candidate-required-ci-")); const router = new SwarmRouter(config(root)); let merged = 0;
    try {
      const github = { async repositoryName() { return "owner/repo"; }, async api(args) { const path = args.at(-1); if (path.includes("check-runs")) return { stdout: JSON.stringify({ check_runs: scenario.runs }) }; if (path.endsWith("/status")) return { stdout: JSON.stringify({ sha: integration.manifest.candidateSha, statuses: [] }) }; throw new Error(`unexpected API ${path}`); } };
      const result = await router.publishCandidate(integration, { remoteGitAdapter: { async pushCandidate({ sha }) { return { status: "pushed", verifiedSha: sha }; } }, pullRequestAdapter: { async ensurePullRequest({ sha }) { return { status: "open", number: 50, url: "https://example.test/pr/50", headSha: sha }; } }, remoteCiAdapter: new GitHubCiAdapter({ github, requiredContexts: ["build"], timeoutMs: 1, pollIntervalMs: 1 }), mergeAdapter: { async merge() { merged += 1; return { status: "merged", mainSha: "b".repeat(40), targetVerified: true }; } } });
      assert.equal(result.terminalState, scenario.expected, scenario.name); assert.equal(merged, scenario.expected === "completed_merged" ? 1 : 0, scenario.name);
    } finally { router.close(); rmSync(root, { recursive: true, force: true }); }
  }
});

test("retry after a merge side effect detects the already-merged PR without repeating merge", async () => {
  const root = mkdtempSync(join(tmpdir(), "candidate-merge-crash-")); const router = new SwarmRouter(config(root)); let remoteMerges = 0; let mergeCalls = 0;
  try {
    const adapters = { remoteGitAdapter: { async pushCandidate({ sha }) { return { status: "pushed", verifiedSha: sha }; } }, pullRequestAdapter: { async ensurePullRequest({ sha }) { return { status: "open", number: 77, url: "https://example.test/pr/77", headSha: sha, duplicate: mergeCalls > 0 }; } }, remoteCiAdapter: { async waitForChecks() { return { status: "passed" }; } }, mergeAdapter: { async merge() { mergeCalls += 1; if (mergeCalls === 1) { remoteMerges += 1; throw new RemoteAdapterError("credentials", "connection dropped after merge"); } return { status: "merged", mainSha: "b".repeat(40), targetVerified: true, duplicate: true }; } } };
    const first = await router.publishCandidate(integration, adapters); assert.equal(first.terminalState, "blocked_credentials"); assert.equal(remoteMerges, 1);
    const second = await router.publishCandidate(integration, adapters); assert.equal(second.terminalState, "completed_merged"); assert.equal(remoteMerges, 1); assert.equal(mergeCalls, 2);
  } finally { router.close(); rmSync(root, { recursive: true, force: true }); }
});
