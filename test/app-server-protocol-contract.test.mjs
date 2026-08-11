import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const schemaPath = process.env.CODEX_APP_SERVER_SCHEMA;
test("generated App Server schema contains the protocol methods used by the client", { skip: !schemaPath ? "set CODEX_APP_SERVER_SCHEMA to a generated Codex schema" : false }, () => {
  assert.equal(existsSync(schemaPath), true, "schema path must exist");
  const schema = statSync(schemaPath).isDirectory()
    ? readdirSync(schemaPath).filter((name) => name.endsWith(".json")).map((name) => readFileSync(join(schemaPath, name), "utf8")).join("\n")
    : readFileSync(schemaPath, "utf8");
  for (const method of ["initialize", "initialized", "thread/start", "turn/start", "turn/interrupt", "turn/completed", "account/read", "account/usage/read", "account/rateLimits/read", "account/rateLimits/updated"]) assert.equal(schema.includes(method), true, `missing ${method}`);
  for (const field of ["dailyUsageBuckets", "startDate", "rateLimitsByLimitId", "windowDurationMins", "requiresOpenaiAuth"]) assert.equal(schema.includes(field), true, `missing account schema field ${field}`);
  for (const field of ["threadId", "turn", "includeTurns", "turns"]) assert.equal(schema.includes(field), true, `missing lifecycle schema field ${field}`);
  const startParams = readFileSync(join(schemaPath, "v2", "TurnStartParams.json"), "utf8");
  const interruptParams = readFileSync(join(schemaPath, "v2", "TurnInterruptParams.json"), "utf8");
  const tokenUsage = readFileSync(join(schemaPath, "v2", "ThreadTokenUsageUpdatedNotification.json"), "utf8");
  assert.equal(startParams.includes('"maxTokens"'), false, "turn/start must not use an invented server-side max-token field");
  assert.equal(startParams.includes('"max_tokens"'), false, "turn/start must not use an invented server-side max-token field");
  for (const field of ["threadId", "turnId"]) assert.equal(interruptParams.includes(`"${field}"`), true, `turn/interrupt missing ${field}`);
  for (const field of ["last", "total", "totalTokens"]) assert.equal(tokenUsage.includes(`"${field}"`), true, `thread/tokenUsage payload missing ${field}`);
});
