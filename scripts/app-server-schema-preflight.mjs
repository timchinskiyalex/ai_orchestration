import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { codexCliInvocation } from "../src/codex-cli-invocation.mjs";

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code ?? signal}`)));
  });
}

const schemaRoot = mkdtempSync(join(tmpdir(), "codex-app-server-schema-"));
try {
  const codex = codexCliInvocation();
  await run(codex.command, [...codex.prefixArgs, "app-server", "generate-json-schema", "--out", schemaRoot]);
  await run(process.execPath, ["--test", "test/app-server-protocol-contract.test.mjs"], { env: { ...process.env, CODEX_APP_SERVER_SCHEMA: schemaRoot } });
} catch (error) {
  console.error(`App Server schema preflight failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  rmSync(schemaRoot, { recursive: true, force: true });
}
