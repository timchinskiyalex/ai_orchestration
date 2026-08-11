import test from "node:test";
import assert from "node:assert/strict";
import { codexCliInvocation } from "../src/codex-cli-invocation.mjs";

test("Windows Codex invocation passes a space-containing schema path as one argument", () => {
  const invocation = codexCliInvocation({
    platform: "win32",
    env: { APPDATA: "C:\\Users\\John Doe\\AppData\\Roaming", PATH: "C:\\Windows\\System32", SystemRoot: "C:\\Windows" },
    fileExists: (path) => path.endsWith("AppData\\Roaming\\npm\\codex.ps1")
  });
  const schemaRoot = "C:\\Users\\John Doe\\AppData\\Local\\Temp\\codex schema";
  const args = [...invocation.prefixArgs, "app-server", "generate-json-schema", "--out", schemaRoot];
  assert.equal(invocation.command, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.equal(args.at(-1), schemaRoot);
  assert.equal(args.filter((arg) => arg === schemaRoot).length, 1);
  assert.equal(args.some((arg) => arg.includes("generate-json-schema --out")), false);
});
