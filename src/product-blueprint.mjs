import { createHash } from "node:crypto";

const types = new Set(["functional", "nfr", "data", "integration", "constraint"]);
const priorities = new Set(["must", "should", "could"]);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const canonical = (value) => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
const fail = (message) => { throw new Error(`Invalid ProductBlueprint: ${message}`); };
const id = (value, label) => {
  if (typeof value !== "string" || !/^[a-z][a-z0-9-]{0,95}$/.test(value)) fail(`${label} must be a stable kebab-case id`);
};

export function documentIdForPath(path) { return `doc-${sha256(path).slice(0, 20)}`; }

export function documentSetDigest(sourceDocuments) {
  return sha256(canonical([...sourceDocuments].sort((left, right) => left.path.localeCompare(right.path))));
}

export function validateProductBlueprint(value, { sourceDocuments = null } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("must be an object");
  for (const key of ["schemaVersion", "kind", "blueprintId", "createdAt", "documentSetDigest", "sourceDocuments", "requirements", "nfrs", "modules", "integrations", "dataModel", "constraints", "assumptions", "decisions", "unresolvedQuestions", "contradictions"]) if (!(key in value)) fail(`missing '${key}'`);
  if (value.schemaVersion !== 1 || value.kind !== "ProductBlueprint") fail("schemaVersion must be 1 and kind must be ProductBlueprint");
  id(value.blueprintId, "blueprintId");
  if (Number.isNaN(Date.parse(value.createdAt))) fail("createdAt must be an ISO timestamp");
  if (!Array.isArray(value.sourceDocuments) || !Array.isArray(value.requirements)) fail("sourceDocuments and requirements must be arrays");
  if (![value.nfrs, value.modules, value.integrations, value.constraints, value.assumptions, value.decisions, value.unresolvedQuestions, value.contradictions].every(Array.isArray) || !value.dataModel || typeof value.dataModel !== "object") fail("collection fields have invalid types");
  const documents = new Map();
  for (const document of value.sourceDocuments) {
    if (!document || typeof document !== "object") fail("every source document must be an object");
    id(document.documentId, "documentId");
    if (typeof document.path !== "string" || !document.path || !/^[a-f0-9]{64}$/.test(document.sha256 ?? "")) fail(`source document '${document.documentId}' is invalid`);
    if (documents.has(document.documentId)) fail(`source document '${document.documentId}' is duplicated`);
    documents.set(document.documentId, document);
  }
  if (!documents.size) fail("must contain at least one source document");
  if (sourceDocuments) {
    const expected = new Map(sourceDocuments.map((document) => [document.documentId, document]));
    if (expected.size !== documents.size || [...documents].some(([key, document]) => canonical(document) !== canonical(expected.get(key)))) fail("sourceDocuments must exactly match the imported document inventory");
  }
  if (value.documentSetDigest !== documentSetDigest(value.sourceDocuments)) fail("documentSetDigest does not match sourceDocuments");
  const requirementIds = new Set();
  for (const requirement of value.requirements) {
    if (!requirement || typeof requirement !== "object") fail("every requirement must be an object");
    for (const key of ["requirementId", "type", "priority", "mandatory", "description", "sourceRefs", "acceptanceCriteria", "constraints"]) if (!(key in requirement)) fail(`requirement is missing '${key}'`);
    id(requirement.requirementId, "requirementId");
    if (requirementIds.has(requirement.requirementId)) fail(`requirement '${requirement.requirementId}' is duplicated`);
    requirementIds.add(requirement.requirementId);
    if (!types.has(requirement.type) || !priorities.has(requirement.priority) || typeof requirement.mandatory !== "boolean" || typeof requirement.description !== "string" || !requirement.description.trim()) fail(`requirement '${requirement.requirementId}' has invalid fields`);
    if (!Array.isArray(requirement.sourceRefs) || !requirement.sourceRefs.length || !Array.isArray(requirement.acceptanceCriteria) || !Array.isArray(requirement.constraints)) fail(`requirement '${requirement.requirementId}' needs sourceRefs, acceptanceCriteria, and constraints arrays`);
    const criteria = new Set();
    for (const criterion of requirement.acceptanceCriteria) {
      if (!criterion || typeof criterion !== "object") fail(`requirement '${requirement.requirementId}' has invalid acceptance criterion`);
      id(criterion.criterionId, "criterionId");
      if (criteria.has(criterion.criterionId) || typeof criterion.description !== "string" || !criterion.description.trim() || (criterion.verificationHint !== undefined && typeof criterion.verificationHint !== "string")) fail(`requirement '${requirement.requirementId}' has invalid acceptance criterion`);
      criteria.add(criterion.criterionId);
    }
    for (const ref of requirement.sourceRefs) {
      if (!ref || typeof ref !== "object" || !documents.has(ref.documentId) || typeof ref.locator !== "string" || !ref.locator || !/^[a-f0-9]{64}$/.test(ref.excerptDigest ?? "")) fail(`requirement '${requirement.requirementId}' has invalid source reference`);
    }
  }
  for (const decision of value.decisions) {
    if (!decision || typeof decision !== "object") fail("invalid decision");
    id(decision.adrId, "adrId");
    if (typeof decision.decision !== "string" || typeof decision.rationale !== "string" || !Array.isArray(decision.sourceRefs)) fail("invalid decision");
  }
  for (const question of value.unresolvedQuestions) {
    if (!question || typeof question !== "object") fail("invalid unresolved question");
    id(question.questionId, "questionId");
    if (typeof question.description !== "string" || !Array.isArray(question.requiredForRequirementIds) || !question.requiredForRequirementIds.every((requirementId) => requirementIds.has(requirementId)) || !["resolved_by_policy", "unresolved"].includes(question.status)) fail(`invalid unresolved question '${question.questionId}'`);
    if (question.policyDefault !== undefined && typeof question.policyDefault !== "string") fail(`policyDefault for '${question.questionId}' must be a declared string`);
  }
  for (const contradiction of value.contradictions) {
    if (!contradiction || typeof contradiction !== "object") fail("invalid contradiction");
    id(contradiction.contradictionId, "contradictionId");
    if (!Array.isArray(contradiction.requirementIds) || !contradiction.requirementIds.every((requirementId) => requirementIds.has(requirementId)) || !Array.isArray(contradiction.sourceRefs) || typeof contradiction.description !== "string" || !["resolved", "unresolved"].includes(contradiction.status)) fail(`invalid contradiction '${contradiction.contradictionId}'`);
    if (contradiction.status === "resolved" && typeof contradiction.resolution !== "string") fail(`resolved contradiction '${contradiction.contradictionId}' needs resolution`);
  }
  return structuredClone(value);
}

// A declared policyDefault is the only autonomous resolution mechanism. The
// resulting ADR is part of the immutable persisted blueprint, never a later
// mutation of it.
export function resolveDeclaredPolicyDefaults(blueprint) {
  const copy = structuredClone(blueprint);
  for (const question of copy.unresolvedQuestions) {
    if (question.status === "unresolved" && question.policyDefault) {
      question.status = "resolved_by_policy";
      const adrId = `adr-policy-${question.questionId}`;
      if (!copy.decisions.some((decision) => decision.adrId === adrId)) copy.decisions.push({ adrId, decision: question.policyDefault, rationale: `Declared policy default for ${question.questionId}: ${question.description}`, sourceRefs: [] });
    }
  }
  return copy;
}

export function specificationBlockers(blueprint) {
  const blockers = [];
  for (const question of blueprint.unresolvedQuestions) if (question.status === "unresolved" && question.requiredForRequirementIds.length) blockers.push(`missing_mandatory_fact:${question.questionId}`);
  for (const contradiction of blueprint.contradictions) if (contradiction.status === "unresolved") blockers.push(`unresolved_contradiction:${contradiction.contradictionId}`);
  return blockers;
}

export function validateRequirementIds(requirementIds, blueprint) {
  if (!Array.isArray(requirementIds) || !requirementIds.length || requirementIds.some((item) => typeof item !== "string")) fail("task requirementIds must be a non-empty array");
  const known = new Set(blueprint.requirements.map((item) => item.requirementId));
  for (const requirementId of requirementIds) if (!known.has(requirementId)) fail(`task references unknown requirement '${requirementId}'`);
}

export function assertMandatoryRequirementCoverage(plan, blueprint) {
  const covered = new Set(plan.tasks.flatMap((task) => task.requirementIds));
  const missing = blueprint.requirements.filter((requirement) => requirement.mandatory && !covered.has(requirement.requirementId)).map((requirement) => requirement.requirementId);
  if (missing.length) throw new Error(`Invalid orchestration JSON: mandatory ProductBlueprint requirements are not planned: ${missing.join(", ")}`);
}
