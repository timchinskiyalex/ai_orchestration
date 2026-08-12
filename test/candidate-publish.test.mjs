import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SwarmRouter } from "../src/router.mjs";
import { RemoteAdapterError } from "../src/remote-adapters.mjs";

function config(root, requireCi = true) {
  const roles = Object.fromEntries(["bootstrap", "planner", "backend", "frontend", "database", "qa", "security", "devops"].map((role) => [role, { sandbox: "read-only", approvalPolicy: "never", tokenBudget: 100, usesWorktree: false }]));
  return { repository: root, runtimeDir: join(root, "runtime"), baseRef: "main", model: "fake", project: { name: "test", documentationDir: "docs/in", generatedDir: "docs/out" }, router: { maxConcurrentTasks: 1, maxChildrenPerTask: 1, maxDelegationDepth: 1, maxPlanTasks: 1, defaultParentBudget: 100, turnTimeoutMs: 1000, approvalMode: "deny" }, autonomy: { mode: "autonomous", autoPush: true, autoCreatePullRequest: true, autoMerge: true }, budget: { weeklyTokenLimit: 1000, weeklyWindowDays: 7 }, quota: { throttleAtUsedPercent: 90 }, delivery: {}, remote: { enabled: true, remoteName: "origin", allowedRemotes: ["origin"], candidateBranchPrefix: "swarm/candidate/", requireCi, mergeMethod: "merge" }, roles };
}
const integration = { path: "docs/out/integration-manifests/manifest.v1.json", manifest: { id: "manifest", schemaVersion: 1, status: "candidate_ready", branch: "swarm/candidate/test", candidateSha: "a".repeat(40), localVerification: { status: "passed" } } };
const blueprint = { schemaVersion: 1, blueprintId: "pb-candidate", documentSetDigest: "d".repeat(64), unresolvedQuestions: [], contradictions: [], requirements: [{ requirementId: "candidate-safe", mandatory: true, acceptanceCriteria: [{ criterionId: "candidate-safe-criterion" }] }] };
const evidence = (kind, status = "pass") => ({ kind, status, reference: `${kind}-reference`, candidateSha: integration.manifest.candidateSha });

function persistedPublication(router) {
  const run = router.createDeliveryRun({ id: "run-candidate", source: "requirements", bootstrapTaskId: null });
  router.store.recordProductBlueprint({ blueprint, artifactPath: "docs/out/product-blueprint.json", digest: "b".repeat(64), deliveryRunId: run.id });
  router.store.linkBlueprintToDelivery(run.id, blueprint.blueprintId);
  router.store.recordIntegrationManifest(integration.path, integration.manifest);
  router.store.updateDeliveryRun(run.id, { candidate: { branch: integration.manifest.branch, sha: integration.manifest.candidateSha }, integrationPath: integration.path });
  const criterionEvidence = { ...evidence("product-e2e"), requirementId: "candidate-safe", criterionId: "candidate-safe-criterion", testId: "e2e/candidate-safe" };
  const report = { schemaVersion: 1, kind: "ProductAcceptanceReport", deliveryRunId: run.id, blueprintId: blueprint.blueprintId, blueprintDigest: "b".repeat(64), documentSetDigest: blueprint.documentSetDigest, integrationManifestPath: integration.path, integrationManifestId: integration.manifest.id, candidateSha: integration.manifest.candidateSha, generatedAt: "2026-01-01T00:00:00.000Z", evidence: { integration: evidence("integration"), qa: evidence("qa"), security: evidence("security"), productE2e: evidence("product-e2e"), ci: evidence("ci") }, results: [{ requirementId: "candidate-safe", criterionId: null, status: "pass", evidence: [evidence("lineage")] }, { requirementId: "candidate-safe", criterionId: "candidate-safe-criterion", status: "pass", evidence: [evidence("lineage"), criterionEvidence] }] };
  return { run, acceptance: router.store.recordProductAcceptanceReport(report) };
}

function greenAdapters(calls, { merge = null, ci = null } = {}) {
  return {
    remoteGitAdapter: { async pushCandidate({ sha }) { calls.push += 1; return { status: "pushed", verifiedSha: sha }; } },
    pullRequestAdapter: { async ensurePullRequest({ sha }) { calls.pr += 1; return { status: "open", number: 41, headSha: sha }; } },
    remoteCiAdapter: { async waitForChecks() { calls.ci += 1; return ci ?? { status: "passed", requiredContexts: ["build"], required: [{ name: "build", state: "passed" }] }; } },
    mergeAdapter: merge ?? { async merge() { calls.merge += 1; return { status: "merged", mainSha: "b".repeat(40), targetVerified: true }; } }
  };
}

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

test("persisted candidate publication is restart-idempotent and required CI failures never merge", async () => {
  const root = mkdtempSync(join(tmpdir(), "candidate-persisted-")); const router = new SwarmRouter(config(root)); const calls = { push: 0, pr: 0, ci: 0, merge: 0 };
  try {
    const { acceptance } = persistedPublication(router);
    const failed = await router.publishCandidate(integration, { ...greenAdapters(calls, { ci: { status: "failed", reason: "build failed" } }), acceptanceReportId: acceptance.id });
    assert.equal(failed.terminalState, "blocked_ci"); assert.equal(calls.merge, 0);
    const merged = await router.publishCandidate(integration, { ...greenAdapters(calls), acceptanceReportId: acceptance.id });
    assert.equal(merged.terminalState, "merge_verified");
    const restarted = await router.publishCandidate(integration, { ...greenAdapters(calls), acceptanceReportId: acceptance.id });
    assert.equal(restarted.terminalState, "merge_verified"); assert.deepEqual(calls, { push: 1, pr: 1, ci: 2, merge: 1 });
  } finally { router.close(); rmSync(root, { recursive: true, force: true }); }
});

test("branch protection, candidate mutation, and post-merge credentials failures cannot duplicate or verify an unsafe merge", async () => {
  const root = mkdtempSync(join(tmpdir(), "candidate-merge-safety-")); const router = new SwarmRouter(config(root)); const calls = { push: 0, pr: 0, ci: 0, merge: 0 };
  try {
    const { acceptance } = persistedPublication(router);
    const protection = await router.publishCandidate(integration, { ...greenAdapters(calls, { merge: { async merge() { throw new RemoteAdapterError("branch_protection", "protected branch refused"); } } }), acceptanceReportId: acceptance.id });
    assert.equal(protection.terminalState, "blocked_branch_protection"); assert.equal(router.store.externalAction(`merge:41:${integration.manifest.candidateSha}`).status, "failed");
    const mutation = await router.publishCandidate(integration, { ...greenAdapters(calls, { merge: { async merge() { throw new RemoteAdapterError("merge_verify_failed", "PR head changed after CI"); } } }), acceptanceReportId: acceptance.id });
    assert.notEqual(mutation.terminalState, "merge_verified"); assert.equal(calls.merge, 0);
    let remotelyMerged = false;
    const afterSideEffect = { async merge() { if (remotelyMerged) return { status: "merged", mainSha: "b".repeat(40), targetVerified: true, duplicate: true }; remotelyMerged = true; calls.merge += 1; throw new RemoteAdapterError("credentials", "credentials lost after merge side effect"); } };
    const interrupted = await router.publishCandidate(integration, { ...greenAdapters(calls, { merge: afterSideEffect }), acceptanceReportId: acceptance.id });
    assert.equal(interrupted.terminalState, "blocked_credentials");
    const resumed = await router.publishCandidate(integration, { ...greenAdapters(calls, { merge: afterSideEffect }), acceptanceReportId: acceptance.id });
    assert.equal(resumed.terminalState, "merge_verified"); assert.equal(calls.merge, 1);
  } finally { router.close(); rmSync(root, { recursive: true, force: true }); }
});
