import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractOrchestrationJson, validateBootstrap, validatePlan, validateWorkerArtifactContract } from "../src/workflow-contract.mjs";
import { documentIdForPath, documentSetDigest } from "../src/product-blueprint.mjs";
import { createImportedSourceResolver, sourceFragmentDigest } from "../src/source-evidence.mjs";

const docs = [{ documentId: "doc-input", path: "input.md", sha256: "a".repeat(64) }];
const blueprint = { schemaVersion: 1, kind: "ProductBlueprint", blueprintId: "pb-test", createdAt: "2026-01-01T00:00:00.000Z", documentSetDigest: documentSetDigest(docs), sourceDocuments: docs, requirements: [{ requirementId: "req-one", type: "functional", priority: "must", mandatory: true, description: "Do the thing.", sourceRefs: [{ documentId: "doc-input", locator: "# thing", excerptDigest: "b".repeat(64) }], acceptanceCriteria: [{ criterionId: "criterion-one", description: "It works." }], constraints: [] }], nfrs: [], modules: [], integrations: [], dataModel: {}, constraints: [], assumptions: [], decisions: [], unresolvedQuestions: [], contradictions: [] };

test("bootstrap contract accepts one source-backed ProductBlueprint", () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-source-")); const documentationDir = "docs/orchestration-input"; const path = "input.md"; const text = "Do the thing.\n";
  const source = { documentId: documentIdForPath(path), path, sha256: createHash("sha256").update(text).digest("hex") };
  try {
    mkdirSync(join(root, documentationDir), { recursive: true }); writeFileSync(join(root, documentationDir, path), text); writeFileSync(join(root, documentationDir, "inventory.json"), JSON.stringify({ files: [source], documentSetDigest: documentSetDigest([source]) }));
    const valid = structuredClone(blueprint); valid.sourceDocuments = [source]; valid.documentSetDigest = documentSetDigest([source]); valid.requirements[0].sourceRefs = [{ documentId: source.documentId, startLine: 1, endLine: 1, excerptDigest: sourceFragmentDigest(text, 1, 1) }];
    const value = extractOrchestrationJson(`\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``);
    assert.equal(validateBootstrap(value, { sourceResolver: createImportedSourceResolver({ repository: root, documentationDir }) }).kind, "ProductBlueprint");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("plan contract validates a dependency DAG", () => {
  const plan = validatePlan({ blueprintId: "pb-test", tasks: [
    { id: "foundation", title: "Foundation", prompt: "Create base", primaryDomain: "backend", supportingDomains: ["qa"], riskFlags: [], humanApprovalRequired: false, estimatedTokens: 2000, dependsOn: [], allowedPaths: ["src"], acceptanceChecks: ["tests pass"], requirementIds: ["req-one"] },
    { id: "feature", title: "Feature", prompt: "Build feature", primaryDomain: "frontend", supportingDomains: ["qa"], riskFlags: [], humanApprovalRequired: false, estimatedTokens: 2000, dependsOn: ["foundation"], allowedPaths: ["src/feature"], acceptanceChecks: ["feature test"], requirementIds: ["req-one"] }
  ] }, { maxTasks: 3, blueprint });
  assert.equal(plan.tasks.length, 2);
});

test("plan contract accepts the documented dependency_supply_chain risk flag", () => {
  const plan = validatePlan({ blueprintId: "pb-test", tasks: [
    { id: "scaffold", title: "Scaffold", prompt: "Create roots", primaryDomain: "devops", supportingDomains: ["security"], riskFlags: ["dependency_supply_chain"], humanApprovalRequired: false, estimatedTokens: 2000, dependsOn: [], allowedPaths: ["frontend", "backend"], acceptanceChecks: ["roots exist"], requirementIds: ["req-one"] }
  ] }, { maxTasks: 2, blueprint });
  assert.equal(plan.tasks[0].riskFlags[0], "dependency_supply_chain");
});

test("plan contract rejects dependency cycles", () => {
  assert.throws(() => validatePlan({ blueprintId: "pb-test", tasks: [
    { id: "one", title: "One", prompt: "Do one", primaryDomain: "backend", supportingDomains: [], riskFlags: [], humanApprovalRequired: false, estimatedTokens: 1000, dependsOn: ["two"], allowedPaths: ["src"], acceptanceChecks: [], requirementIds: ["req-one"] },
    { id: "two", title: "Two", prompt: "Do two", primaryDomain: "backend", supportingDomains: [], riskFlags: [], humanApprovalRequired: false, estimatedTokens: 1000, dependsOn: ["one"], allowedPaths: ["src"], acceptanceChecks: [], requirementIds: ["req-one"] }
  ] }, { maxTasks: 3, blueprint }), /cycle/);
});

test("PlanBatch requires a verified base before strict materialization", () => {
  assert.throws(() => validatePlan({ blueprintId: "pb-test", tasks: [] }, { maxTasks: 1, blueprint, requirePlanBatch: true }), /PlanBatch is missing/);
  const batch = validatePlan({ schemaVersion: 1, kind: "PlanBatch", id: "batch-1", deliveryRunId: "run-1", blueprintId: "pb-test", wave: 1, basedOnCheckpointSha: "a".repeat(40), createdAt: "2026-01-01T00:00:00.000Z", tasks: [{ id: "writer", title: "Writer", prompt: "Write", primaryDomain: "backend", supportingDomains: [], riskFlags: [], humanApprovalRequired: false, estimatedTokens: 1, dependsOn: [], allowedPaths: ["src"], acceptanceChecks: [], requirementIds: ["req-one"] }] }, { maxTasks: 1, blueprint, requirePlanBatch: true });
  assert.equal(batch.kind, "PlanBatch");
});

test("WorkerArtifact rejects a multi-parent identity", () => {
  const artifact = { schemaVersion: 1, kind: "WorkerArtifact", taskId: "writer", baseSha: "a".repeat(40), headSha: "b".repeat(40), dependencies: ["a", "b"] };
  assert.throws(() => validateWorkerArtifactContract(artifact), /zero or one parent/);
});
