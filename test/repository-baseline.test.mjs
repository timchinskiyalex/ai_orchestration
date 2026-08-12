import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { assertRepositoryBaselineCurrent, captureRepositoryBaselineDraft, finalizeRepositoryBaseline, requiredBaselineBehaviorIds, validateTaskBaselineBehaviorIds } from "../src/repository-baseline.mjs";
import { validateProductAcceptanceReport } from "../src/final-acceptance.mjs";

const git = (root, args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
const sha = "a".repeat(40);
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "repository-baseline-")); git(root, ["init", "-b", "main"]); git(root, ["config", "user.email", "test@example.com"]); git(root, ["config", "user.name", "Test"]);
  mkdirSync(join(root, "src")); writeFileSync(join(root, "src", "value.mjs"), "export const value = 1;\n");
  const declaration = { schemaVersion: 1, kind: "RepositoryBaselineDeclaration", behaviors: [{ behaviorId: "value-preserved", category: "behavior", label: "Value remains available", protectedSurfaces: ["src"], verificationCommandId: "package-script:test", selectedTrackedPaths: ["src/value.mjs"] }], impactEdges: [{ protectedSurface: "src", behaviorId: "value-preserved" }] };
  writeFileSync(join(root, "baseline.json"), JSON.stringify(declaration)); git(root, ["add", "src/value.mjs", "baseline.json"]); git(root, ["commit", "-m", "initial"]);
  const baseSha = git(root, ["rev-parse", "main"]); const overlay = { repository: { baseSha }, verificationCommands: [{ id: "package-script:test", executable: "node", args: ["--version"], cwd: "." }] };
  return { root, baseSha, overlay, declarationPath: join(root, "baseline.json") };
}

test("brownfield draft binds the exact base tree and final baseline", () => {
  const ctx = fixture(); const draft = captureRepositoryBaselineDraft({ repository: ctx.root, baseRef: "main", declarationPath: ctx.declarationPath, overlay: ctx.overlay });
  const baseline = finalizeRepositoryBaseline({ draft, blueprintId: "blueprint", blueprintDigest: "b".repeat(64) });
  assert.equal(baseline.baseSha, ctx.baseSha); assert.equal(baseline.selectedTrackedPaths.length, 1);
  assert.doesNotThrow(() => assertRepositoryBaselineCurrent({ repository: ctx.root, baseRef: "main", declarationPath: ctx.declarationPath, overlay: ctx.overlay, baseline, blueprintId: "blueprint", blueprintDigest: "b".repeat(64) }));
  assert.deepEqual(requiredBaselineBehaviorIds(["src/value.mjs"], baseline), ["value-preserved"]);
  assert.throws(() => validateTaskBaselineBehaviorIds({ allowedPaths: ["src/value.mjs"], baselineBehaviorIds: [] }, baseline), /scope_mismatch/);
  assert.throws(() => validateTaskBaselineBehaviorIds({ allowedPaths: ["docs"], baselineBehaviorIds: ["value-preserved"] }, baseline), /scope_mismatch/);
  assert.deepEqual(validateTaskBaselineBehaviorIds({ allowedPaths: ["docs"], baselineBehaviorIds: [] }, baseline), []);
});

test("moving ref, declaration mutation, and tracked identity mismatches invalidate baseline", () => {
  const ctx = fixture(); const draft = captureRepositoryBaselineDraft({ repository: ctx.root, baseRef: "main", declarationPath: ctx.declarationPath, overlay: ctx.overlay }); const baseline = finalizeRepositoryBaseline({ draft, blueprintId: "blueprint", blueprintDigest: "b".repeat(64) });
  writeFileSync(join(ctx.root, "src", "value.mjs"), "export const value = 2;\n"); git(ctx.root, ["add", "src/value.mjs"]); git(ctx.root, ["commit", "-m", "move"]);
  assert.throws(() => assertRepositoryBaselineCurrent({ repository: ctx.root, baseRef: "main", declarationPath: ctx.declarationPath, overlay: ctx.overlay, baseline, blueprintId: "blueprint", blueprintDigest: "b".repeat(64) }), /repository_baseline:/);
});

test("candidate acceptance requires exact protected behavior proof", () => {
  const candidate = sha; const blueprint = { blueprintId: "blueprint", documentSetDigest: "d".repeat(64), requirements: [{ requirementId: "req", mandatory: true, acceptanceCriteria: [{ criterionId: "criterion" }] }] };
  const manifest = { id: "manifest", candidateSha: candidate }; const baseline = { digest: "b".repeat(64), behaviors: [{ behaviorId: "value-preserved", verificationCommandId: "package-script:test" }] };
  const evidence = (kind, status = "pass") => ({ kind, status, reference: kind, candidateSha: candidate });
  const report = { schemaVersion: 1, kind: "ProductAcceptanceReport", deliveryRunId: "run", blueprintId: "blueprint", blueprintDigest: "c".repeat(64), documentSetDigest: blueprint.documentSetDigest, integrationManifestPath: "manifest", integrationManifestId: "manifest", candidateSha: candidate, generatedAt: new Date().toISOString(), repositoryBaselineDigest: baseline.digest, behaviorEvidence: [], evidence: { integration: evidence("integration"), qa: evidence("qa"), security: evidence("security"), productE2e: evidence("product"), ci: evidence("ci") }, results: [{ requirementId: "req", criterionId: null, status: "pass", evidence: [evidence("lineage")] }, { requirementId: "req", criterionId: "criterion", status: "pass", evidence: [{ ...evidence("product-e2e"), requirementId: "req", criterionId: "criterion", testId: "test" }] }] };
  assert.throws(() => validateProductAcceptanceReport(report, { blueprint, blueprintDigest: "c".repeat(64), manifest, manifestPath: "manifest", repositoryBaseline: baseline }), /behavior evidence/);
  report.behaviorEvidence = [{ behaviorId: "value-preserved", commandId: "package-script:test", baselineDigest: baseline.digest, candidateSha: candidate, classification: "pass", safeReference: "repository-baseline:value-preserved", durationMs: 1, exitClassification: "passed" }];
  assert.doesNotThrow(() => validateProductAcceptanceReport(report, { blueprint, blueprintDigest: "c".repeat(64), manifest, manifestPath: "manifest", repositoryBaseline: baseline }));
  report.behaviorEvidence[0].candidateSha = "c".repeat(40);
  assert.throws(() => validateProductAcceptanceReport(report, { blueprint, blueprintDigest: "c".repeat(64), manifest, manifestPath: "manifest", repositoryBaseline: baseline }), /behavior evidence/);
});
