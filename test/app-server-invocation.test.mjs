import test from "node:test";
import assert from "node:assert/strict";
import { appServerInvocation } from "../src/app-server-invocation.mjs";
import { codexCliInvocation } from "../src/codex-cli-invocation.mjs";

test("Windows long-running App Server launcher uses cmd.exe, never the PowerShell shim", () => {
  const invocation = appServerInvocation({ platform: "win32", env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" } });
  assert.equal(invocation.command, "C:\\Windows\\System32\\cmd.exe");
  assert.deepEqual(invocation.args, ["/d", "/s", "/c", "codex app-server"]);
  assert.equal(`${invocation.command} ${invocation.args.join(" ")}`.includes("powershell"), false);
  assert.equal(`${invocation.command} ${invocation.args.join(" ")}`.includes("codex.ps1"), false);
});

test("non-Windows long-running App Server launcher invokes codex directly", () => {
  assert.deepEqual(appServerInvocation({ platform: "linux" }), { command: "codex", args: ["app-server"] });
  assert.deepEqual(appServerInvocation({ platform: "darwin" }), { command: "codex", args: ["app-server"] });
});

test("schema-preflight launcher remains the existing PowerShell shim on Windows", () => {
  const invocation = codexCliInvocation({
    platform: "win32", env: { APPDATA: "C:\\Users\\Jane Doe\\AppData\\Roaming", PATH: "", SystemRoot: "C:\\Windows" },
    fileExists: (path) => path.endsWith("codex.ps1")
  });
  assert.match(invocation.command, /powershell\.exe$/i);
  assert.equal(invocation.prefixArgs.includes("-File"), true);
  assert.equal(invocation.prefixArgs.at(-1).endsWith("codex.ps1"), true);
});
