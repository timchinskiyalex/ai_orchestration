import { specificationBlockers } from "./product-blueprint.mjs";

export const PRODUCT_ACCEPTANCE_SCHEMA_VERSION = 1;
export const PRODUCT_ACCEPTANCE_KIND = "ProductAcceptanceReport";
export const ACCEPTANCE_STATUSES = new Set(["pass", "partial", "missing", "not_verified", "blocked"]);
const sha = (value) => /^[a-f0-9]{40,64}$/i.test(value ?? "");
const fail = (message) => { throw new Error(`Invalid ProductAcceptanceReport: ${message}`); };
function validateResult(result, requirements, criteria) {
  if (!result || !ACCEPTANCE_STATUSES.has(result.status) || !requirements.has(result.requirementId) || (result.criterionId != null && !criteria.has(`${result.requirementId}:${result.criterionId}`))) fail("result identity or status is invalid");
  if (!Array.isArray(result.evidence) || !result.evidence.length) fail("results require structured evidence");
  for (const evidence of result.evidence) if (!evidence || typeof evidence.kind !== "string" || typeof evidence.reference !== "string" || !ACCEPTANCE_STATUSES.has(evidence.status) || (evidence.candidateSha && !sha(evidence.candidateSha))) fail("evidence is invalid");
}
export function validateProductAcceptanceReport(report, { blueprint, blueprintDigest, manifest, manifestPath = null } = {}) {
  for (const key of ["schemaVersion", "kind", "deliveryRunId", "blueprintId", "blueprintDigest", "documentSetDigest", "integrationManifestPath", "integrationManifestId", "candidateSha", "generatedAt", "results", "evidence"]) if (!(key in (report ?? {}))) fail(`missing '${key}'`);
  if (report.schemaVersion !== 1 || report.kind !== PRODUCT_ACCEPTANCE_KIND || !report.deliveryRunId || report.blueprintId !== blueprint?.blueprintId || report.blueprintDigest !== blueprintDigest || report.documentSetDigest !== blueprint.documentSetDigest) fail("source-backed identity mismatch");
  if (!sha(report.candidateSha) || report.candidateSha.toLowerCase() !== manifest?.candidateSha?.toLowerCase() || report.integrationManifestId !== manifest.id || (manifestPath && report.integrationManifestPath !== manifestPath)) fail("candidate or integration manifest identity mismatch");
  const requirements = new Set(blueprint.requirements.map((item) => item.requirementId)); const criteria = new Set(blueprint.requirements.flatMap((item) => item.acceptanceCriteria.map((criterion) => `${item.requirementId}:${criterion.criterionId}`)));
  for (const result of report.results ?? []) validateResult(result, requirements, criteria);
  for (const requirement of blueprint.requirements) { if (!report.results.some((item) => item.requirementId === requirement.requirementId && item.criterionId == null)) fail(`missing requirement '${requirement.requirementId}'`); for (const criterion of requirement.acceptanceCriteria) if (!report.results.some((item) => item.requirementId === requirement.requirementId && item.criterionId === criterion.criterionId)) fail(`missing criterion '${criterion.criterionId}'`); }
  return structuredClone(report);
}
export function productAcceptancePasses(report, { blueprint }) {
  if (specificationBlockers(blueprint).length || !["integration", "qa", "security", "productE2e", "ci"].every((key) => report.evidence?.[key]?.status === "pass")) return false;
  return blueprint.requirements.filter((requirement) => requirement.mandatory).every((requirement) => report.results.filter((result) => result.requirementId === requirement.requirementId).every((result) => result.status === "pass"));
}
