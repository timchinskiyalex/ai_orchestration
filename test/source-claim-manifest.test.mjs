import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { documentIdForPath, documentSetDigest, policyDigest, sourceClaimBlockers } from "../src/product-blueprint.mjs";
import { compileImportedSourceClaimManifest, sourceFragmentDigest } from "../src/source-evidence.mjs";
import { validateBootstrap } from "../src/workflow-contract.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");

function context({ declarationMutator = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), "source-claims-")); const documentationDir = "docs/orchestration-input";
  const path = "requirements.md"; const text = "First mandatory statement\nSecond statement\n";
  const file = { documentId: documentIdForPath(path), path, sha256: sha(text) };
  const refs = [1, 2].map((line) => ({ documentId: file.documentId, startLine: line, endLine: line, excerptDigest: sourceFragmentDigest(text, line, line) }));
  const declaration = { schemaVersion: 1, kind: "SourceClaimsDeclaration", documentSetDigest: documentSetDigest([file]), documents: [{ ...file, coverage: [{ claimId: "claim-first", ...refs[0] }, { claimId: "claim-second", ...refs[1] }] }], claims: [{ claimId: "claim-first", classification: "mandatory", sourceRefs: [refs[0]] }, { claimId: "claim-second", classification: "non_mandatory", sourceRefs: [refs[1]] }] };
  declarationMutator?.(declaration, refs, file);
  mkdirSync(join(root, documentationDir), { recursive: true });
  writeFileSync(join(root, documentationDir, path), text);
  writeFileSync(join(root, documentationDir, "inventory.json"), JSON.stringify({ files: [file], documentSetDigest: documentSetDigest([file]) }));
  writeFileSync(join(root, documentationDir, "source-claims.json"), JSON.stringify(declaration));
  return { root, documentationDir, file, refs, manifest: () => compileImportedSourceClaimManifest({ repository: root, documentationDir }) };
}

function blueprint(ctx, manifest, overrides = {}) {
  return { schemaVersion: 1, kind: "ProductBlueprint", blueprintId: "claim-blueprint", createdAt: "2026-01-01T00:00:00.000Z", documentSetDigest: documentSetDigest([ctx.file]), sourceDocuments: [ctx.file], requirements: [{ requirementId: "first-requirement", type: "functional", priority: "must", mandatory: true, description: "First requirement", sourceClaimIds: ["claim-first"], sourceRefs: [ctx.refs[0]], acceptanceCriteria: [{ criterionId: "first-criterion", description: "Works" }], constraints: [] }], nfrs: [], modules: [], integrations: [], dataModel: {}, constraints: [], assumptions: [], decisions: [], unresolvedQuestions: [], contradictions: [], ...overrides };
}

test("strict declaration compiles canonical manifest and accepts exact mandatory disposition", () => {
  const ctx = context();
  try {
    const manifest = ctx.manifest();
    const value = validateBootstrap(blueprint(ctx, manifest), { sourceClaimManifest: manifest, sourceResolver: { sourceDocuments: [ctx.file], verify: () => {} } });
    assert.equal(value.schemaVersion, 3); assert.equal(value.sourceClaimManifest.digest, manifest.digest);
  } finally { rmSync(ctx.root, { recursive: true, force: true }); }
});

test("missing, overlapping, foreign, invalid digest, duplicate id, and invalid classification declarations fail closed", () => {
  const cases = [
    (d) => { d.documents[0].coverage.pop(); },
    (d) => { d.documents[0].coverage[1].startLine = 1; },
    (d) => { d.documents[0].documentId = "doc-foreign"; },
    (d) => { d.documents[0].coverage[0].excerptDigest = "a".repeat(64); },
    (d) => { d.claims.push({ ...d.claims[0] }); },
    (d) => { d.claims[0].classification = "guess"; }
  ];
  for (const mutate of cases) { const ctx = context({ declarationMutator: mutate }); try { assert.throws(ctx.manifest, /source_claim_contract/); } finally { rmSync(ctx.root, { recursive: true, force: true }); } }
  const missing = context();
  try { rmSync(join(missing.root, missing.documentationDir, "source-claims.json")); assert.throws(missing.manifest, /missing_required_source_claims_declaration/); }
  finally { rmSync(missing.root, { recursive: true, force: true }); }
});

test("omitted or vague mandatory claim mappings and empty mandatory criteria fail before Planner", () => {
  const ctx = context();
  try {
    const manifest = ctx.manifest(); const options = { sourceClaimManifest: manifest, sourceResolver: { sourceDocuments: [ctx.file], verify: () => {} } };
    const omitted = blueprint(ctx, manifest); delete omitted.requirements[0].sourceClaimIds;
    assert.throws(() => validateBootstrap(omitted, options), /sourceClaimIds/);
    const vague = blueprint(ctx, manifest); vague.requirements[0].sourceRefs = [ctx.refs[1]];
    assert.throws(() => validateBootstrap(vague, options), /do not exactly agree/);
    const empty = blueprint(ctx, manifest); empty.requirements[0].acceptanceCriteria = [];
    assert.throws(() => validateBootstrap(empty, options), /non-empty mandatory acceptance criteria/);
  } finally { rmSync(ctx.root, { recursive: true, force: true }); }
});

test("trusted policy needs exact policy claim scope and unresolved/ambiguous claims remain blocked", () => {
  const ctx = context({ declarationMutator: (d) => { d.claims[0].classification = "ambiguous"; } });
  try {
    const manifest = ctx.manifest();
    const policy = { policyId: "policy-first", version: "1", scope: { kind: "unresolved_question", questionIds: ["question-first"], claimIds: ["claim-first"] }, affectedRequirementIds: ["first-requirement"], resolvedValue: "Use deterministic default" }; policy.digest = policyDigest(policy);
    const candidate = blueprint(ctx, manifest, { requirements: [], unresolvedQuestions: [{ questionId: "question-first", description: "Ambiguous", requiredForRequirementIds: ["first-requirement"], sourceClaimIds: ["claim-first"], proposedPolicyId: policy.policyId, proposedPolicyVersion: policy.version, proposedPolicyDigest: policy.digest, proposedResolution: policy.resolvedValue }] });
    // A question must still name a real affected requirement; retain it while
    // removing the requirement disposition so policy is the sole disposition.
    candidate.requirements = [blueprint(ctx, manifest).requirements[0]]; candidate.requirements[0].sourceClaimIds = ["claim-second"];
    candidate.requirements[0].sourceRefs = [ctx.refs[1]]; candidate.requirements[0].mandatory = false;
    const authorized = validateBootstrap(candidate, { sourceClaimManifest: manifest, sourceResolver: { sourceDocuments: [ctx.file], verify: () => {} }, policyRegistry: { schemaVersion: 1, policies: [policy] } });
    assert.deepEqual(sourceClaimBlockers(authorized, manifest), []);
    policy.scope.claimIds = ["claim-second"];
    policy.digest = policyDigest(policy);
    assert.throws(() => validateBootstrap(candidate, { sourceClaimManifest: manifest, sourceResolver: { sourceDocuments: [ctx.file], verify: () => {} }, policyRegistry: { schemaVersion: 1, policies: [policy] } }), /ambiguous source claim/);
  } finally { rmSync(ctx.root, { recursive: true, force: true }); }
});

test("source or inventory mutation invalidates a canonical manifest", () => {
  const ctx = context();
  try {
    const manifest = ctx.manifest(); assert.ok(manifest.digest);
    writeFileSync(join(ctx.root, ctx.documentationDir, "requirements.md"), "changed\nSecond statement\n");
    assert.throws(ctx.manifest, /no longer matches/);
  } finally { rmSync(ctx.root, { recursive: true, force: true }); }
});
