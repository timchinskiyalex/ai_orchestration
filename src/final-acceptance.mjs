import { createHash } from "node:crypto";
import { specificationBlockers } from "./product-blueprint.mjs";

export const PRODUCT_ACCEPTANCE_SCHEMA_VERSION = 1;
export const PRODUCT_ACCEPTANCE_KIND = "ProductAcceptanceReport";
export const ACCEPTANCE_STATUSES = new Set(["pass", "partial", "missing", "not_verified", "blocked"]);
const sha = (value) => /^[a-f0-9]{40,64}$/i.test(value ?? "");
const fail = (message) => { throw new Error(`Invalid ProductAcceptanceReport: ${message}`); };
export const acceptanceDigest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function validateResult(result, knownRequirements, knownCriteria) {
  if (!result || typeof result !== "object" || !ACCEPTANCE_STATUSES.has(result.status)) fail("result has invalid status");
  if (!knownRequirements.has(result.requirementId)) fail(`unknown requirement '${result.requirementId}'`);
  if (result.criterionId !== null && result.criterionId !== undefined && !knownCriteria.has(`${result.requirementId}:${result.criterionId}`)) fail(`unknown criterion '${result.criterionId}'`);
  if (!Array.isArray(result.evidence) || !result.evidence.length) fail(`result '${result.requirementId}' requires structured evidence`);
  for (const evidence of result.evidence) {
    if (!evidence || typeof evidence !== "object" || typeof evidence.kind !== "string" || typeof evidence.reference !== "string" || !evidence.reference || !ACCEPTANCE_STATUSES.has(evidence.status)) fail("evidence must be a structured reference with status");
    if (evidence.candidateSha !== undefined && !sha(evidence.candidateSha)) fail("evidence candidateSha is invalid");
  }
}

export function validateProductAcceptanceReport(report, { blueprint, blueprintDigest, manifest, manifestPath = null } = {}) {
  if (!report || typeof report !== "object") fail("must be an object");
  for (const key of ["schemaVersion", "kind", "deliveryRunId", "blueprintId", "blueprintDigest", "documentSetDigest", "integrationManifestPath", "integrationManifestId", "candidateSha", "generatedAt", "results", "evidence"]) if (!(key in report)) fail(`missing '${key}'`);
  if (report.schemaVersion !== PRODUCT_ACCEPTANCE_SCHEMA_VERSION || report.kind !== PRODUCT_ACCEPTANCE_KIND) fail("schema version or kind is invalid");
  if (!report.deliveryRunId || report.blueprintId !== blueprint?.blueprintId || report.blueprintDigest !== blueprintDigest || report.documentSetDigest !== blueprint?.documentSetDigest) fail("blueprint identity does not match persisted source-backed blueprint");
  if (!sha(report.candidateSha) || !manifest || report.candidateSha.toLowerCase() !== manifest.candidateSha?.toLowerCase()) fail("candidate SHA does not match integration manifest");
  if (report.integrationManifestId !== manifest.id || (manifestPath && report.integrationManifestPath !== manifestPath)) fail("integration manifest identity does not match");
  if (Number.isNaN(Date.parse(report.generatedAt)) || !Array.isArray(report.results) || !report.results.length || !report.evidence || typeof report.evidence !== "object") fail("timestamp, results, or evidence is invalid");
  const knownRequirements = new Set(blueprint.requirements.map((item) => item.requirementId));
  const knownCriteria = new Set(blueprint.requirements.flatMap((item) => item.acceptanceCriteria.map((criterion) => `${item.requirementId}:${criterion.criterionId}`)));
  for (const result of report.results) validateResult(result, knownRequirements, knownCriteria);
  for (const requirement of blueprint.requirements) {
    const requirementResult = report.results.find((item) => item.requirementId === requirement.requirementId && (item.criterionId === null || item.criterionId === undefined));
    if (!requirementResult) fail(`missing requirement result '${requirement.requirementId}'`);
    for (const criterion of requirement.acceptanceCriteria) if (!report.results.some((item) => item.requirementId === requirement.requirementId && item.criterionId === criterion.criterionId)) fail(`missing criterion result '${criterion.criterionId}'`);
  }
  return structuredClone(report);
}

export function productAcceptancePasses(report, { blueprint }) {
  const blockers = specificationBlockers(blueprint);
  if (blockers.length || report.evidence.integration?.status !== "pass" || report.evidence.qa?.status !== "pass" || report.evidence.security?.status !== "pass" || report.evidence.productE2e?.status !== "pass" || report.evidence.ci?.status !== "pass") return false;
  return blueprint.requirements.filter((item) => item.mandatory).every((requirement) => report.results.filter((item) => item.requirementId === requirement.requirementId).every((item) => item.status === "pass"));
}
