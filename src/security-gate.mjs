import { validateQualityGateReport } from "./quality-gate.mjs";

export const SECURITY_GATE_VERSION = 1;

// Security and Quality share the same strictly bounded finding shape. Keeping
// the security contract separate prevents a Markdown review from being treated
// as a passing security decision.
export function validateSecurityGateReport(value) {
  const report = validateQualityGateReport(value);
  return { ...report, schemaVersion: SECURITY_GATE_VERSION, kind: "SecurityGateReport" };
}
