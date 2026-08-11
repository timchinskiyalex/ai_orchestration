import test from "node:test";
import assert from "node:assert/strict";
import { extractOrchestrationJson, validateBootstrap, validatePlan } from "../src/workflow-contract.mjs";
import { documentSetDigest } from "../src/product-blueprint.mjs";

const docs = [{ documentId: "doc-input", path: "input.md", sha256: "a".repeat(64) }];
const blueprint = { schemaVersion: 1, kind: "ProductBlueprint", blueprintId: "pb-test", createdAt: "2026-01-01T00:00:00.000Z", documentSetDigest: documentSetDigest(docs), sourceDocuments: docs, requirements: [{ requirementId: "req-one", type: "functional", priority: "must", mandatory: true, description: "Do the thing.", sourceRefs: [{ documentId: "doc-input", locator: "# thing", excerptDigest: "b".repeat(64) }], acceptanceCriteria: [{ criterionId: "criterion-one", description: "It works." }], constraints: [] }], nfrs: [], modules: [], integrations: [], dataModel: {}, constraints: [], assumptions: [], decisions: [], unresolvedQuestions: [], contradictions: [] };

test("bootstrap contract accepts one source-backed ProductBlueprint", () => {
  const value = extractOrchestrationJson(`\`\`\`json\n${JSON.stringify(blueprint)}\n\`\`\``);
  assert.equal(validateBootstrap(value).kind, "ProductBlueprint");
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
