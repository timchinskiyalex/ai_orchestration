import test from "node:test";
import assert from "node:assert/strict";
import { normalizePlannerPlanForProject } from "../src/router.mjs";
import { validatePlan } from "../src/workflow-contract.mjs";

const roots = [{ id: "frontend", path: "frontend", adapter: "next-node" }, { id: "backend", path: "backend", adapter: "dotnet" }];
const scaffold = { id: "scaffold-product", title: "Scaffold", prompt: "Create roots", primaryDomain: "devops", supportingDomains: ["security"], riskFlags: ["dependency_supply_chain"], humanApprovalRequired: false, estimatedTokens: 10, dependsOn: [], allowedPaths: ["backend/"], acceptanceChecks: ["roots exist"] };

test("controller canonicalizes scaffold paths to every declared product root before validation", () => {
  const api = { id: "api", title: "API", prompt: "Implement API", primaryDomain: "backend", supportingDomains: ["security"], riskFlags: ["auth_or_authorization"], humanApprovalRequired: false, estimatedTokens: 10, dependsOn: [], allowedPaths: ["backend/api"], acceptanceChecks: ["tests pass"] };
  const plan = normalizePlannerPlanForProject({ tasks: [scaffold, api] }, roots);
  assert.deepEqual(plan.tasks[0].allowedPaths, ["backend", "frontend"]);
  assert.deepEqual(plan.tasks[1].dependsOn, ["scaffold-product"]);
  assert.doesNotThrow(() => validatePlan(plan, { maxTasks: 2, productRoots: roots }));
});
