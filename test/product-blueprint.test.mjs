import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { StateStore } from "../src/state-store.mjs";
import { assertMandatoryRequirementCoverage, documentIdForPath, documentSetDigest, policyDigest, specificationBlockers, validateProductBlueprint } from "../src/product-blueprint.mjs";
import { validateBootstrap } from "../src/workflow-contract.mjs";
import { createImportedSourceResolver, sourceFragmentDigest } from "../src/source-evidence.mjs";

function evidenceContext() {
  const root = mkdtempSync(join(tmpdir(), "product-blueprint-source-")); const documentationDir = "docs/orchestration-input"; const path = "input.md"; const text = "Required feature\n";
  const file = { documentId: documentIdForPath(path), path, sha256: createHash("sha256").update(text).digest("hex") };
  mkdirSync(join(root, documentationDir), { recursive: true }); writeFileSync(join(root, documentationDir, path), text); writeFileSync(join(root, documentationDir, "inventory.json"), JSON.stringify({ files: [file], documentSetDigest: documentSetDigest([file]) }));
  return { root, docs: [file], resolver: createImportedSourceResolver({ repository: root, documentationDir }), digest: sourceFragmentDigest(text, 1, 1) };
}
function blueprint(docs, digest, overrides = {}) {
  return { schemaVersion: 1, kind: "ProductBlueprint", blueprintId: "pb-stable", createdAt: "2026-01-01T00:00:00.000Z", documentSetDigest: documentSetDigest(docs), sourceDocuments: docs, requirements: [{ requirementId: "req-must", type: "functional", priority: "must", mandatory: true, description: "Required feature", sourceRefs: [{ documentId: docs[0].documentId, startLine: 1, endLine: 1, excerptDigest: digest }], acceptanceCriteria: [{ criterionId: "criterion-must", description: "Passes" }], constraints: [] }], nfrs: [], modules: [], integrations: [], dataModel: {}, constraints: [], assumptions: [], decisions: [], unresolvedQuestions: [], contradictions: [], ...overrides };
}

test("ProductBlueprint is source-backed, stable, and immutable after persistence", () => {
  const dir = mkdtempSync(join(tmpdir(), "product-blueprint-")); const evidence = evidenceContext(); const store = new StateStore(join(dir, "state.sqlite"));
  try {
    const value = validateProductBlueprint(blueprint(evidence.docs, evidence.digest), { sourceResolver: evidence.resolver });
    store.recordProductBlueprint({ blueprint: value, artifactPath: "docs/orchestration-generated/blueprints/pb-stable.v1.json", digest: "c".repeat(64) });
    assert.equal(store.productBlueprint("pb-stable").blueprint.requirements[0].sourceRefs[0].startLine, 1);
    assert.throws(() => store.recordProductBlueprint({ blueprint: value, artifactPath: "other.json", digest: "d".repeat(64) }), /immutable/);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); rmSync(evidence.root, { recursive: true, force: true }); }
});
test("mandatory coverage and unknown requirement IDs reject before task materialization", () => {
  const value = blueprint([{ documentId: "doc-input", path: "input.md", sha256: "a".repeat(64) }], "b".repeat(64));
  assert.throws(() => assertMandatoryRequirementCoverage({ tasks: [] }, value), /not planned/);
});

test("trusted policy proposals create a controller ADR while unresolved facts and contradictions block", () => {
  const docs = [{ documentId: "doc-input", path: "input.md", sha256: "a".repeat(64) }]; const value = (overrides) => blueprint(docs, "b".repeat(64), overrides); const sourceResolver = { verify() {} };
  const policy = { policyId: "default-region", version: "1", scope: { kind: "unresolved_question", questionIds: ["q-default"] }, affectedRequirementIds: ["req-must"], resolvedValue: "Use EU region" }; policy.digest = policyDigest(policy);
  const resolved = validateBootstrap(value({ unresolvedQuestions: [{ questionId: "q-default", description: "Region", requiredForRequirementIds: ["req-must"], proposedPolicyId: policy.policyId, proposedPolicyVersion: policy.version, proposedPolicyDigest: policy.digest, proposedResolution: policy.resolvedValue }] }), { sourceResolver, policyRegistry: { schemaVersion: 1, policies: [policy] } });
  assert.equal(resolved.unresolvedQuestions[0].status, "resolved_by_policy"); assert.match(resolved.decisions[0].rationale, /Controller-authorized/); assert.equal(resolved.resolutionAuthority.records[0].policyId, "default-region");
  assert.deepEqual(specificationBlockers(value({ unresolvedQuestions: [{ questionId: "q-missing", description: "Missing API endpoint", requiredForRequirementIds: ["req-must"], status: "unresolved" }] })), ["missing_mandatory_fact:q-missing"]);
  assert.deepEqual(specificationBlockers(value({ contradictions: [{ contradictionId: "c-source", requirementIds: ["req-must"], sourceRefs: [], description: "Conflicting sources", status: "unresolved" }] })), ["unresolved_contradiction:c-source"]);
});
