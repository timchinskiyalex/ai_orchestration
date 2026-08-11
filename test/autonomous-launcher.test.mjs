import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

test("autonomous launcher has no interactive prompt and starts the complete delivery command", () => {
  const script = readFileSync(join(root, "scripts", "start-delivery.ps1"), "utf8");
  assert.doesNotMatch(script, /Read-Host|APPROVE|OVERRIDE|\bPUSH\b/i);
  assert.match(script, /src\/index\.mjs', 'deliver/);
  assert.match(script, /completed_merged/);
  assert.match(script, /docs\/orchestration-generated/);
});
