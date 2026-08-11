import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingestDocumentation } from "../src/project-intake.mjs";

test("documentation intake copies only Markdown and writes an inventory inside the project", () => {
  const root = mkdtempSync(join(tmpdir(), "orchestration-intake-"));
  const source = join(root, "source");
  const repository = join(root, "repository");
  mkdirSync(join(source, "nested"), { recursive: true });
  mkdirSync(repository);
  writeFileSync(join(source, "overview.md"), "# Overview\n");
  writeFileSync(join(source, "nested", "api.md"), "# API\n");
  writeFileSync(join(source, "ignore.txt"), "ignore");
  try {
    const result = ingestDocumentation({ source, repository, destinationRelative: "docs/orchestration-input" });
    assert.equal(result.files, 2);
    assert.equal(readFileSync(join(repository, "docs", "orchestration-input", "overview.md"), "utf8"), "# Overview\n");
    assert.equal(readFileSync(join(repository, "docs", "orchestration-input", "nested", "api.md"), "utf8"), "# API\n");
    const inventory = JSON.parse(readFileSync(result.inventoryPath, "utf8"));
    assert.deepEqual(inventory.files.map((item) => item.path), ["nested/api.md", "overview.md"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
