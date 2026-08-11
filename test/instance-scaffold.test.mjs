import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffoldInstance } from "../src/instance-scaffold.mjs";

test("instance scaffold copies the generic core and records the template version", () => {
  const root = mkdtempSync(join(tmpdir(), "orchestration-template-"));
  const template = join(root, "template");
  const target = join(root, "instance");
  mkdirSync(join(template, "config"), { recursive: true });
  mkdirSync(join(template, "docs"));
  mkdirSync(join(template, "policies"));
  mkdirSync(join(template, "roles"));
  mkdirSync(join(template, "src"));
  mkdirSync(join(template, "scripts"));
  mkdirSync(join(template, "test"));
  writeFileSync(join(template, "package.json"), JSON.stringify({ name: "template", version: "0.1.0", scripts: { "test:app-server-schema": "node scripts/schema.mjs", "e2e:live": "node scripts/live.mjs" } }));
  writeFileSync(join(template, ".gitignore"), "runtime/\n");
  for (const directory of ["config", "docs", "policies", "roles", "src", "scripts", "test"]) writeFileSync(join(template, directory, "placeholder.txt"), directory);
  writeFileSync(join(template, "scripts", "schema.mjs"), "", "utf8"); writeFileSync(join(template, "scripts", "live.mjs"), "", "utf8");
  try {
    scaffoldInstance({ templateRoot: template, target, projectName: "Example Project" });
    const marker = JSON.parse(readFileSync(join(target, ".orchestration-template.json"), "utf8"));
    assert.equal(marker.template, "template");
    assert.equal(marker.projectName, "Example Project");
    assert.equal(readFileSync(join(target, "src", "placeholder.txt"), "utf8"), "src");
    const scripts = JSON.parse(readFileSync(join(target, "package.json"), "utf8")).scripts;
    for (const command of Object.values(scripts)) for (const path of String(command).match(/scripts\/[\w.-]+\.mjs/g) ?? []) assert.equal(existsSync(join(target, path)), true);
    assert.equal("test:app-server-schema" in scripts, true); assert.equal("e2e:live" in scripts, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
