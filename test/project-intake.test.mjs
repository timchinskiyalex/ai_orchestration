import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingestDocumentation } from "../src/project-intake.mjs";
import { createHash } from "node:crypto";
import { documentIdForPath, documentSetDigest } from "../src/product-blueprint.mjs";
import { sourceFragmentDigest } from "../src/source-evidence.mjs";

test("documentation intake copies only Markdown and writes an inventory inside the project", () => {
  const root = mkdtempSync(join(tmpdir(), "orchestration-intake-"));
  const source = join(root, "source");
  const repository = join(root, "repository");
  mkdirSync(join(source, "nested"), { recursive: true });
  mkdirSync(repository);
  writeFileSync(join(source, "overview.md"), "# Overview\n");
  writeFileSync(join(source, "nested", "api.md"), "# API\n");
  writeFileSync(join(source, "ignore.txt"), "ignore");
  const docs = [["nested/api.md", "# API\n"], ["overview.md", "# Overview\n"]].map(([path, text]) => ({ documentId: documentIdForPath(path), path, sha256: createHash("sha256").update(text).digest("hex"), text }));
  writeFileSync(join(source, "source-claims.json"), JSON.stringify({ schemaVersion: 1, kind: "SourceClaimsDeclaration", documentSetDigest: documentSetDigest(docs.map(({ text, ...doc }) => doc)), documents: docs.map(({ text, ...doc }, index) => ({ ...doc, coverage: [{ claimId: `claim-${index}`, documentId: doc.documentId, startLine: 1, endLine: 1, excerptDigest: sourceFragmentDigest(text, 1, 1) }] })), claims: docs.map(({ text, ...doc }, index) => ({ claimId: `claim-${index}`, classification: "non_mandatory", sourceRefs: [{ documentId: doc.documentId, startLine: 1, endLine: 1, excerptDigest: sourceFragmentDigest(text, 1, 1) }] })) }));
  try {
    const result = ingestDocumentation({ source, repository, destinationRelative: "docs/orchestration-input" });
    assert.equal(result.files, 2);
    assert.equal(readFileSync(join(repository, "docs", "orchestration-input", "overview.md"), "utf8"), "# Overview\n");
    assert.equal(readFileSync(join(repository, "docs", "orchestration-input", "nested", "api.md"), "utf8"), "# API\n");
    const inventory = JSON.parse(readFileSync(result.inventoryPath, "utf8"));
    assert.deepEqual(inventory.files.map((item) => item.path), ["nested/api.md", "overview.md"]);
    assert.equal(inventory.files.every((item) => /^doc-[a-f0-9]{20}$/.test(item.documentId) && /^[a-f0-9]{64}$/.test(item.sha256)), true);
    assert.match(inventory.documentSetDigest, /^[a-f0-9]{64}$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
