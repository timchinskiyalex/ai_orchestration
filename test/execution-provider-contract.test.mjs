import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { AppServerExecutionProvider } from "../src/app-server-execution-provider.mjs";
import { EXECUTION_PROVIDER_VERSION, REQUIRED_EXECUTION_CAPABILITIES, envelope, assertCapabilities, validateEnvelope } from "../src/execution-provider-contract.mjs";

class Transport extends EventEmitter {
  async connect() {} shutdown() { this.closed = true; } diagnostics() { return { stderrTail: "token=secret", process: { exited: false } }; }
  async request(method) { return method === "account/read" ? { account: {} } : method === "account/usage/read" ? { dailyUsageBuckets: [] } : { rateLimits: null }; }
  async startThread() { return { thread: { id: "thread-1" } }; } async setGoal() {}
  async startTurn() { return { turn: { id: "turn-1" } }; } async waitForTurn() { return { id: "turn-1", status: "completed" }; }
  async readThread() { return { thread: { turns: [{ id: "turn-1", items: [{ type: "agentMessage", text: "done" }] }] } }; } async interruptTurn() {}
}
class DeterministicProvider {
  async handshake(args) { return envelope({ operation: "handshake", correlationId: args.correlationId, success: true, data: { capabilities: [...REQUIRED_EXECUTION_CAPABILITIES], providerRunId: "fake" } }); }
  async startThread(args) { return envelope({ operation: "start_thread", correlationId: args.correlationId, success: true, data: { providerRunId: "fake", threadId: "thread-1" } }); }
  async observeTerminal(args) { return envelope({ operation: "observe_terminal", correlationId: args.correlationId, success: true, data: { providerRunId: "fake", threadId: "thread-1", turnId: "turn-1", terminalClass: "completed", usage: { totalTokens: 3 } } }); }
}
const call = async (provider, operation, data = {}, ids = []) => {
  const correlationId = `c-${operation}`; const names = { handshake: "handshake", start_thread: "startThread", observe_terminal: "observeTerminal" };
  return validateEnvelope(await provider[names[operation]]({ contractVersion: EXECUTION_PROVIDER_VERSION, correlationId, data }), { operation, correlationId, requiredIds: ids });
};

test("App Server adapter and deterministic provider share handshake/lifecycle conformance", async () => {
  for (const provider of [new AppServerExecutionProvider({ client: new Transport() }), new DeterministicProvider()]) {
    const handshake = await call(provider, "handshake", { contractVersion: EXECUTION_PROVIDER_VERSION }, ["providerRunId"]); assertCapabilities(handshake);
    const thread = await call(provider, "start_thread", {}, ["threadId"]); assert.equal(thread.threadId, "thread-1");
    const terminal = await call(provider, "observe_terminal", { threadId: "thread-1", turnId: "turn-1", timeoutMs: 5 }, ["threadId", "turnId"]); assert.equal(terminal.terminalClass, "completed");
  }
});

test("contract validation fails closed for malformed, wrong-operation, and correlation-mismatched envelopes", () => {
  assert.throws(() => validateEnvelope({}, { operation: "start_thread", correlationId: "c" }), /unsupported_contract_version/);
  assert.throws(() => validateEnvelope(envelope({ operation: "start_turn", correlationId: "c", success: true, data: {} }), { operation: "start_thread", correlationId: "c" }), /protocol_violation/);
  assert.throws(() => validateEnvelope(envelope({ operation: "start_thread", correlationId: "other", success: true, data: {} }), { operation: "start_thread", correlationId: "c" }), /correlation_mismatch/);
});

test("adapter shutdown and interrupt are idempotent and diagnostics are bounded/redacted", async () => {
  const transport = new Transport(); const provider = new AppServerExecutionProvider({ client: transport }); await call(provider, "handshake", { contractVersion: EXECUTION_PROVIDER_VERSION });
  const interrupt = { contractVersion: EXECUTION_PROVIDER_VERSION, correlationId: "i", data: { threadId: "thread-1", turnId: "turn-1" } };
  assert.equal((await provider.interruptTurn(interrupt)).success, true); assert.equal((await provider.interruptTurn({ ...interrupt, correlationId: "i2" })).success, true);
  const diagnostics = await provider.diagnostics({ contractVersion: EXECUTION_PROVIDER_VERSION, correlationId: "d", data: {} }); assert.match(diagnostics.data.diagnostics, /redacted/);
  await provider.shutdown({ contractVersion: EXECUTION_PROVIDER_VERSION, correlationId: "s", data: {} }); await provider.shutdown({ contractVersion: EXECUTION_PROVIDER_VERSION, correlationId: "s2", data: {} }); assert.equal(transport.closed, true);
});
