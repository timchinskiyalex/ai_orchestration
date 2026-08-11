import test from "node:test";
import assert from "node:assert/strict";
import { remediationScope, requiresHumanQualityGate, validateQualityGateReport } from "../src/quality-gate.mjs";

const remediation = { verdict: "remediation_required", summary: "A bounded fix is needed.", findings: [{ id: "QA-1", severity: "medium", path: "src/value.mjs", evidence: "Value does not meet the declared expectation.", requiredFix: "Update the exported value only.", verification: "npm test" }], executedChecks: [], notRunChecks: [] };

test("QualityGateReport is structured, bounded to relative paths, and yields narrowed remediation scope", () => {
  const report = validateQualityGateReport(remediation);
  assert.equal(report.schemaVersion, 1);
  assert.deepEqual(remediationScope(report, { allowedPaths: ["src"] }), ["src/value.mjs"]);
  assert.throws(() => remediationScope(report, { allowedPaths: ["test"] }), /exceed/);
  assert.throws(() => validateQualityGateReport({ ...remediation, findings: [{ ...remediation.findings[0], path: "../secret" }] }), /relative/);
});

test("high findings, blocked reports, and exhausted rounds require human escalation", () => {
  const report = validateQualityGateReport(remediation);
  assert.equal(requiresHumanQualityGate(report, false), false);
  assert.equal(requiresHumanQualityGate(report, true), true);
  assert.equal(requiresHumanQualityGate({ ...report, verdict: "blocked" }, false), true);
  assert.equal(requiresHumanQualityGate({ ...report, findings: [{ ...report.findings[0], severity: "critical" }] }, false), true);
});
