import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { documentSetDigest } from "../src/product-blueprint.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");

export function fakeBlueprint(repository, { question = null, contradiction = null } = {}) {
  const inventory = JSON.parse(readFileSync(join(repository, "docs", "orchestration-input", "inventory.json"), "utf8"));
  const sourceDocuments = inventory.files.map(({ documentId, path, sha256 }) => ({ documentId, path, sha256 }));
  const source = sourceDocuments[0];
  return {
    schemaVersion: 1, kind: "ProductBlueprint", blueprintId: "pb-test", createdAt: "2026-01-01T00:00:00.000Z", documentSetDigest: documentSetDigest(sourceDocuments), sourceDocuments,
    requirements: [{ requirementId: "fix-value", type: "functional", priority: "must", mandatory: true, description: "Fix the value.", sourceRefs: [{ documentId: source.documentId, locator: "# Requirement", excerptDigest: digest("Fix value.") }], acceptanceCriteria: [{ criterionId: "value-test", description: "The value test passes.", verificationHint: "npm test" }], constraints: [] }],
    nfrs: [], modules: [], integrations: [], dataModel: {}, constraints: [], assumptions: [], decisions: [], unresolvedQuestions: question ? [question] : [], contradictions: contradiction ? [contradiction] : []
  };
}
export function fakePlan() {
  return { blueprintId: "pb-test", tasks: [{ id: "writer", title: "Writer", prompt: "Writer", primaryDomain: "backend", supportingDomains: [], riskFlags: [], humanApprovalRequired: false, estimatedTokens: 20, dependsOn: [], allowedPaths: ["src/value.mjs"], acceptanceChecks: ["npm test"], requirementIds: ["fix-value"] }] };
}
