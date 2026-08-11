import test from "node:test";
import assert from "node:assert/strict";
import { validateSecurityGateReport } from "../src/security-gate.mjs";
import { requiresHumanQualityGate } from "../src/quality-gate.mjs";

const remediation = { verdict: "remediation_required", summary: "A bounded security fix is required.", findings: [{ id: "SEC-1", severity: "medium", path: "src/value.mjs", evidence: "The reviewed path needs a bounded correction.", requiredFix: "Apply the correction only in this path.", verification: "npm test" }], executedChecks: [], notRunChecks: [] };

test("SecurityGateReport is structured and never accepts Markdown as a pass", () => {
  const report = validateSecurityGateReport(remediation);
  assert.equal(report.kind, "SecurityGateReport");
  assert.equal(report.verdict, "remediation_required");
  assert.throws(() => validateSecurityGateReport("looks good"), /Invalid QualityGateReport/);
});

test("Security blocked/high/critical findings escalate to a human", () => {
  const report = validateSecurityGateReport(remediation);
  assert.equal(requiresHumanQualityGate({ ...report, verdict: "blocked" }, false), true);
  assert.equal(requiresHumanQualityGate({ ...report, findings: [{ ...report.findings[0], severity: "high" }] }, false), true);
  assert.equal(requiresHumanQualityGate({ ...report, findings: [{ ...report.findings[0], severity: "critical" }] }, false), true);
});
