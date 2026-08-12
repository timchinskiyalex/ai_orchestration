import { isAbsolute } from "node:path";
import { isWriteSurfaceAncestorOrSame } from "./write-surface.mjs";

export const QUALITY_GATE_VERSION = 1;
const severities = new Set(["low", "medium", "high", "critical"]);
const verdicts = new Set(["pass", "remediation_required", "blocked"]);

function fail(message) { throw new Error(`Invalid QualityGateReport: ${message}`); }
function safeRelativePath(value) {
  return typeof value === "string" && value.length > 0 && !isAbsolute(value) && !value.split(/[\\/]/).some((part) => part === ".." || part === ".");
}
function secretLike(value) {
  return /(?:\b(?:api[_-]?key|password|secret|token)\b\s*[:=]|\bsk-[A-Za-z0-9_-]{8,}|\bBearer\s+[A-Za-z0-9._-]{8,})/i.test(value);
}

export function validateQualityGateReport(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("must be one object");
  for (const field of ["verdict", "summary", "findings", "executedChecks", "notRunChecks"]) if (!(field in value)) fail(`missing '${field}'`);
  if (!verdicts.has(value.verdict) || typeof value.summary !== "string" || !Array.isArray(value.findings) || !Array.isArray(value.executedChecks) || !Array.isArray(value.notRunChecks)) fail("has invalid top-level fields");
  if (secretLike(value.summary)) fail("summary may not contain a secret-like value");
  const ids = new Set();
  for (const finding of value.findings) {
    if (!finding || typeof finding !== "object") fail("finding must be an object");
    for (const field of ["id", "severity", "path", "evidence", "requiredFix", "verification"]) if (typeof finding[field] !== "string" || !finding[field].trim()) fail(`finding missing '${field}'`);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(finding.id) || ids.has(finding.id)) fail("finding ids must be stable and unique");
    if (!severities.has(finding.severity)) fail(`unsupported severity '${finding.severity}'`);
    if (!safeRelativePath(finding.path)) fail("finding path must be normalized and relative");
    if ([finding.evidence, finding.requiredFix, finding.verification].some(secretLike)) fail("finding contains a secret-like value");
    ids.add(finding.id);
  }
  if (value.verdict === "pass" && value.findings.length) fail("pass cannot carry unresolved findings");
  if (value.verdict === "remediation_required" && !value.findings.length) fail("remediation_required needs findings");
  return { schemaVersion: QUALITY_GATE_VERSION, kind: "QualityGateReport", verdict: value.verdict, summary: value.summary.trim(), findings: value.findings.map((finding) => ({ ...finding, path: finding.path.replace(/\\/g, "/") })), executedChecks: value.executedChecks, notRunChecks: value.notRunChecks };
}

export function remediationScope(report, writerTask) {
  const paths = [...new Set(report.findings.map((finding) => finding.path))];
  if (!paths.length || !paths.every((path) => (writerTask.allowedPaths ?? []).some((allowed) => {
    try { return isWriteSurfaceAncestorOrSame(allowed, path); }
    catch { return false; }
  }))) throw new Error("Quality remediation findings exceed the writer TaskEnvelope scope");
  return paths;
}

export function requiresHumanQualityGate(report, maxRoundReached) {
  return maxRoundReached || report.verdict === "blocked" || report.findings.some((finding) => finding.severity === "high" || finding.severity === "critical");
}
