import test from "node:test";
import assert from "node:assert/strict";
import { validateProductAcceptanceReport, productAcceptancePasses } from "../src/final-acceptance.mjs";

const sha = "a".repeat(40);
const blueprint = { blueprintId: "pb-test", documentSetDigest: "d".repeat(64), unresolvedQuestions: [], contradictions: [], requirements: [{ requirementId: "req-test", mandatory: true, acceptanceCriteria: [{ criterionId: "criterion-test" }] }] };
const manifest = { id: "manifest-test", candidateSha: sha };
function report(status = "pass", product = "pass") {
  const evidence = (kind, value) => ({ kind, reference: `${kind}-record`, status: value, candidateSha: sha });
  const criterionEvidence = { ...evidence("product-e2e", product), requirementId: "req-test", criterionId: "criterion-test", testId: "e2e/test/criterion" };
  return { schemaVersion: 1, kind: "ProductAcceptanceReport", deliveryRunId: "run-test", blueprintId: "pb-test", blueprintDigest: "b".repeat(64), documentSetDigest: blueprint.documentSetDigest, integrationManifestPath: "docs/out/manifest.json", integrationManifestId: manifest.id, candidateSha: sha, generatedAt: "2026-01-01T00:00:00.000Z", evidence: { integration: evidence("integration", "pass"), qa: evidence("qa", "pass"), security: evidence("security", "pass"), productE2e: evidence("product", product), ci: evidence("ci", "pass") }, results: [{ requirementId: "req-test", criterionId: null, status, evidence: [evidence("lineage", status)] }, { requirementId: "req-test", criterionId: "criterion-test", status: status === "pass" ? product : status, evidence: [evidence("lineage", status), criterionEvidence] }] };
}

test("every non-pass final-acceptance status prevents a mandatory acceptance", () => {
  for (const status of ["partial", "missing", "not_verified", "blocked"]) {
    const value = validateProductAcceptanceReport(report(status), { blueprint, blueprintDigest: "b".repeat(64), manifest, manifestPath: "docs/out/manifest.json" });
    assert.equal(productAcceptancePasses(value, { blueprint }), false, status);
  }
  assert.throws(() => validateProductAcceptanceReport(report("pass", "not_verified"), { blueprint, blueprintDigest: "b".repeat(64), manifest, manifestPath: "docs/out/manifest.json" }), /cannot pass while a criterion is not pass/);
});

test("candidate and immutable manifest identities are required", () => {
  const bad = report(); bad.candidateSha = "c".repeat(40);
  assert.throws(() => validateProductAcceptanceReport(bad, { blueprint, blueprintDigest: "b".repeat(64), manifest, manifestPath: "docs/out/manifest.json" }), /candidate SHA/);
  const manifestBad = report(); manifestBad.integrationManifestId = "other";
  assert.throws(() => validateProductAcceptanceReport(manifestBad, { blueprint, blueprintDigest: "b".repeat(64), manifest, manifestPath: "docs/out/manifest.json" }), /manifest identity/);
});

test("every top-level and result evidence item is stable and bound to the exact candidate", () => {
  for (const mutate of [
    (value) => { value.evidence.integration = { status: "pass" }; },
    (value) => { value.evidence.qa.kind = "   "; },
    (value) => { value.evidence.security.reference = ""; },
    (value) => { delete value.evidence.productE2e.candidateSha; },
    (value) => { value.evidence.ci.candidateSha = "c".repeat(40); },
    (value) => { value.results[0].evidence[0].candidateSha = "c".repeat(40); },
    (value) => { value.results[1].evidence[0].kind = ""; },
    (value) => { delete value.results[1].evidence[1].testId; },
    (value) => { value.results[1].evidence[1].criterionId = "other"; }
  ]) {
    const value = report(); mutate(value);
    assert.throws(() => validateProductAcceptanceReport(value, { blueprint, blueprintDigest: "b".repeat(64), manifest, manifestPath: "docs/out/manifest.json" }));
  }
});

test("final acceptance rejects unknown, duplicate, and missing criterion mappings", () => {
  const unknown = report(); unknown.results[1].criterionId = "unknown"; unknown.results[1].evidence[1].criterionId = "unknown";
  assert.throws(() => validateProductAcceptanceReport(unknown, { blueprint, blueprintDigest: "b".repeat(64), manifest, manifestPath: "docs/out/manifest.json" }), /unknown criterion/);
  const duplicate = report(); duplicate.results.push(structuredClone(duplicate.results[1]));
  assert.throws(() => validateProductAcceptanceReport(duplicate, { blueprint, blueprintDigest: "b".repeat(64), manifest, manifestPath: "docs/out/manifest.json" }), /duplicate result mapping/);
  const missing = report(); missing.results.pop();
  assert.throws(() => validateProductAcceptanceReport(missing, { blueprint, blueprintDigest: "b".repeat(64), manifest, manifestPath: "docs/out/manifest.json" }), /missing criterion result/);
});
