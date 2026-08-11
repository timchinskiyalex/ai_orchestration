import test from "node:test";
import assert from "node:assert/strict";
import { extractOrchestrationJson, validateBootstrap, validatePlan } from "../src/workflow-contract.mjs";

test("bootstrap contract accepts one structured result", () => {
  const value = extractOrchestrationJson("```json\n{\"summary\":\"Build API\",\"assumptions\":[],\"risks\":[],\"humanGates\":[\"scope\"]}\n```");
  assert.equal(validateBootstrap(value).summary, "Build API");
});

test("plan contract validates a dependency DAG", () => {
  const plan = validatePlan({ tasks: [
    { id: "foundation", title: "Foundation", prompt: "Create base", primaryDomain: "backend", supportingDomains: ["qa"], riskFlags: [], humanApprovalRequired: false, estimatedTokens: 2000, dependsOn: [], allowedPaths: ["src"], acceptanceChecks: ["tests pass"] },
    { id: "feature", title: "Feature", prompt: "Build feature", primaryDomain: "frontend", supportingDomains: ["qa"], riskFlags: [], humanApprovalRequired: false, estimatedTokens: 2000, dependsOn: ["foundation"], allowedPaths: ["src/feature"], acceptanceChecks: ["feature test"] }
  ] }, { maxTasks: 3 });
  assert.equal(plan.tasks.length, 2);
});

test("plan contract accepts the documented dependency_supply_chain risk flag", () => {
  const plan = validatePlan({ tasks: [
    { id: "scaffold", title: "Scaffold", prompt: "Create roots", primaryDomain: "devops", supportingDomains: ["security"], riskFlags: ["dependency_supply_chain"], humanApprovalRequired: false, estimatedTokens: 2000, dependsOn: [], allowedPaths: ["frontend", "backend"], acceptanceChecks: ["roots exist"] }
  ] }, { maxTasks: 2 });
  assert.equal(plan.tasks[0].riskFlags[0], "dependency_supply_chain");
});

test("plan contract rejects dependency cycles", () => {
  assert.throws(() => validatePlan({ tasks: [
    { id: "one", title: "One", prompt: "Do one", primaryDomain: "backend", supportingDomains: [], riskFlags: [], humanApprovalRequired: false, estimatedTokens: 1000, dependsOn: ["two"], allowedPaths: ["src"], acceptanceChecks: [] },
    { id: "two", title: "Two", prompt: "Do two", primaryDomain: "backend", supportingDomains: [], riskFlags: [], humanApprovalRequired: false, estimatedTokens: 1000, dependsOn: ["one"], allowedPaths: ["src"], acceptanceChecks: [] }
  ] }, { maxTasks: 3 }), /cycle/);
});
