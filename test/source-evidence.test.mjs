import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { documentIdForPath, documentSetDigest, specificationBlockers } from "../src/product-blueprint.mjs";
import { createImportedSourceResolver, sourceFragmentDigest } from "../src/source-evidence.mjs";
import { validateBootstrap } from "../src/workflow-contract.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function sourceContext({ path = "requirements.md", text = "alpha\r\nbravo\r\ncharlie\r\n" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "source-evidence-")); const documentationDir = "docs/orchestration-input";
  const file = { documentId: documentIdForPath(path), path, sha256: sha256(text.replace(/\r\n?/g, "\n")) };
  mkdirSync(join(root, documentationDir), { recursive: true }); writeFileSync(join(root, documentationDir, path), text); writeFileSync(join(root, documentationDir, "inventory.json"), JSON.stringify({ files: [file], documentSetDigest: documentSetDigest([file]) }));
  return { root, documentationDir, file, text, resolver: createImportedSourceResolver({ repository: root, documentationDir }) };
}

function blueprint(context, ref = { documentId: context.file.documentId, startLine: 2, endLine: 3, excerptDigest: sourceFragmentDigest(context.text, 2, 3) }) {
  return {
    schemaVersion: 1, kind: "ProductBlueprint", blueprintId: "pb-evidence", createdAt: "2026-01-01T00:00:00.000Z", documentSetDigest: documentSetDigest([context.file]), sourceDocuments: [context.file],
    requirements: [{ requirementId: "req-evidence", type: "functional", priority: "must", mandatory: true, description: "Evidence-backed requirement", sourceRefs: [ref], acceptanceCriteria: [{ criterionId: "criterion-evidence", description: "Passes" }], constraints: [] }],
    nfrs: [], modules: [], integrations: [], dataModel: {}, constraints: [], assumptions: [], decisions: [{ adrId: "adr-evidence", decision: "Use evidence", rationale: "Imported source", sourceRefs: [ref] }], unresolvedQuestions: [], contradictions: [{ contradictionId: "contradiction-evidence", requirementIds: ["req-evidence"], sourceRefs: [ref], description: "Checked source", status: "resolved", resolution: "No conflict" }]
  };
}

function validate(context, value = blueprint(context)) {
  return validateBootstrap(value, { sourceResolver: context.resolver });
}

test("controller verifies a valid multiline SourceRef for requirements, decisions, and contradictions", () => {
  const context = sourceContext();
  try { assert.equal(validate(context).kind, "ProductBlueprint"); }
  finally { rmSync(context.root, { recursive: true, force: true }); }
});

test("controller rejects random and wrong-fragment SHA-256 digests", () => {
  const context = sourceContext();
  try {
    assert.throws(() => validate(context, blueprint(context, { documentId: context.file.documentId, startLine: 2, endLine: 3, excerptDigest: "a".repeat(64) })), /digest does not match/);
    assert.throws(() => validate(context, blueprint(context, { documentId: context.file.documentId, startLine: 2, endLine: 3, excerptDigest: sourceFragmentDigest(context.text, 1, 1) })), /digest does not match/);
  } finally { rmSync(context.root, { recursive: true, force: true }); }
});

test("controller rejects invalid, out-of-range, and legacy SourceRef ranges", () => {
  const context = sourceContext();
  try {
    assert.throws(() => validate(context, blueprint(context, { documentId: context.file.documentId, startLine: 4, endLine: 2, excerptDigest: "a".repeat(64) })), /invalid line range/);
    assert.throws(() => validate(context, blueprint(context, { documentId: context.file.documentId, startLine: 2, endLine: 9, excerptDigest: "a".repeat(64) })), /outside imported document/);
    assert.throws(() => validate(context, blueprint(context, { documentId: context.file.documentId, locator: "# legacy", excerptDigest: "a".repeat(64) })), /integer startLine and endLine/);
  } finally { rmSync(context.root, { recursive: true, force: true }); }
});

test("controller invalidates a blueprint when imported source content changes", () => {
  const context = sourceContext();
  try {
    const value = blueprint(context); validate(context, value);
    writeFileSync(join(context.root, context.documentationDir, context.file.path), "alpha\nchanged\ncharlie\n");
    assert.throws(() => validate(context, value), /no longer matches its controller inventory/);
  } finally { rmSync(context.root, { recursive: true, force: true }); }
});

test("controller rejects document substitution and inventory traversal", () => {
  const context = sourceContext();
  try {
    const substituted = blueprint(context); substituted.sourceDocuments = [{ ...context.file, path: "other.md" }]; substituted.documentSetDigest = documentSetDigest(substituted.sourceDocuments);
    assert.throws(() => validate(context, substituted), /sourceDocuments must exactly match/);
  } finally { rmSync(context.root, { recursive: true, force: true }); }
  const root = mkdtempSync(join(tmpdir(), "source-evidence-traversal-")); const documentationDir = "docs/orchestration-input";
  try {
    mkdirSync(join(root, documentationDir), { recursive: true }); const path = "../outside.md"; const file = { documentId: documentIdForPath(path), path, sha256: "a".repeat(64) };
    writeFileSync(join(root, documentationDir, "inventory.json"), JSON.stringify({ files: [file] }));
    assert.throws(() => createImportedSourceResolver({ repository: root, documentationDir }), /unsafe source entry/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("unresolved mandatory source facts remain blocked_specification inputs", () => {
  const context = sourceContext();
  try {
    const value = blueprint(context); value.unresolvedQuestions = [{ questionId: "missing-source-fact", description: "Missing mandatory source fact", requiredForRequirementIds: ["req-evidence"], status: "unresolved" }];
    assert.deepEqual(specificationBlockers(validate(context, value)), ["missing_mandatory_fact:missing-source-fact"]);
  } finally { rmSync(context.root, { recursive: true, force: true }); }
});
