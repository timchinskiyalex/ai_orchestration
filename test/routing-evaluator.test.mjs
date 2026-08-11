import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gradeRoutingFixture } from "../src/routing-evaluator.mjs";

const base = { id: "work", title: "work", prompt: "work", estimatedTokens: 100, dependsOn: [], allowedPaths: ["src"], acceptanceChecks: [], humanApprovalRequired: false };
test("routing evaluator enforces security and database gates", () => {
  assert.equal(gradeRoutingFixture({ plan: { tasks: [{ ...base, primaryDomain: "backend", supportingDomains: ["security"], riskFlags: ["auth_or_authorization"] }] }, expected: { valid: true, domains: ["backend", "security"] } }).passed, true);
  assert.equal(gradeRoutingFixture({ plan: { tasks: [{ ...base, primaryDomain: "database", supportingDomains: [], riskFlags: ["schema_change"] }] }, expected: { valid: false } }).passed, true);
  assert.equal(gradeRoutingFixture({ plan: { tasks: [{ ...base, primaryDomain: "devops", supportingDomains: [], riskFlags: ["permission_change"] }] }, expected: { valid: false } }).passed, true);
});

test("machine-readable routing regression fixtures have deterministic grades", () => {
  const directory = join(import.meta.dirname, "fixtures", "routing");
  for (const file of readdirSync(directory).filter((name) => name.endsWith(".json"))) {
    const fixture = JSON.parse(readFileSync(join(directory, file), "utf8"));
    assert.equal(gradeRoutingFixture(fixture).passed, true, file);
  }
});
