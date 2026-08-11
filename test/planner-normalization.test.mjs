import test from "node:test";
import assert from "node:assert/strict";
import { normalizePlannerPlanForProject } from "../src/router.mjs";
import { validatePlan } from "../src/workflow-contract.mjs";

const roots = [{ id: "frontend", path: "frontend", adapter: "next-node" }, { id: "backend", path: "backend", adapter: "dotnet" }];
const scaffold = { id: "scaffold-product", title: "Scaffold", prompt: "Create roots", primaryDomain: "devops", supportingDomains: ["security"], riskFlags: ["dependency_supply_chain"], humanApprovalRequired: false, estimatedTokens: 10, dependsOn: [], allowedPaths: ["backend/"], acceptanceChecks: ["roots exist"] };

test("controller canonicalizes scaffold paths to every declared product root before validation", () => {
  const plan = normalizePlannerPlanForProject({ tasks: [scaffold] }, roots);
  assert.deepEqual(plan.tasks[0].allowedPaths, ["backend", "frontend"]);
  assert.doesNotThrow(() => validatePlan(plan, { maxTasks: 2, productRoots: roots }));
});
