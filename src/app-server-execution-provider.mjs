import { EventEmitter } from "node:events";
import { AppServerClient } from "./app-server-client.mjs";
import { EXECUTION_PROVIDER_VERSION, REQUIRED_EXECUTION_CAPABILITIES, envelope, safeDiagnostics } from "./execution-provider-contract.mjs";

const terminal = new Set(["completed", "failed", "interrupted", "cancelled"]);
const usage = (params = {}) => {
  const raw = params.tokenUsage ?? params.usage ?? params;
  const value = raw?.last ?? raw?.total ?? raw;
  const totalTokens = Number(value?.totalTokens);
  return Number.isFinite(totalTokens) ? { totalTokens } : null;
};
const codeFor = (error) => {
  const text = String(error?.message ?? error).toLowerCase();
  if (text.includes("timed out")) return "timeout";
  if (text.includes("exited")) return "process_exit";
  if (text.includes("closed") || text.includes("shutdown")) return "shutdown";
  if (text.includes("interrupt")) return "interrupted";
  return "transport_failure";
};

// Kept with the protocol adapter for low-level client lifecycle coverage; the
// Router never receives this raw nesting.
export function agentResultForTurn(response, turnId) {
  const turn = response?.thread?.turns?.find((item) => item?.id === turnId);
  const text = (turn?.items ?? []).filter((item) => item?.type === "agentMessage" && typeof item.text === "string").at(-1)?.text;
  if (!text?.trim()) throw new Error(`No final agent message was found for turn ${turnId}`);
  return text;
}

export class AppServerExecutionProvider extends EventEmitter {
  constructor({ cwd, client = null, clientFactory = null } = {}) {
    super();
    this.client = client ?? (clientFactory ? clientFactory({ cwd }) : new AppServerClient({ cwd }));
    this.connected = false; this.closed = false; this.interrupted = new Set(); this.active = new Map();
    this.client.on?.("notification", (message) => this.#notification(message));
    this.client.on?.("exit", (details) => this.emit("lifecycle", envelope({ operation: "observe_terminal", correlationId: null, success: false, errorCode: "process_exit", errorClass: "transport", diagnostics: details })));
  }
  async handshake(args) {
    if (args.contractVersion !== EXECUTION_PROVIDER_VERSION) return this.#failure("handshake", args, "unsupported_contract_version", "protocol");
    try { if (!this.connected) { await this.client.connect(); this.connected = true; } return this.#ok("handshake", args, { capabilities: [...REQUIRED_EXECUTION_CAPABILITIES], providerRunId: "app-server" }); }
    catch (error) { return this.#caught("handshake", args, error); }
  }
  async accountRead(args) { return this.#raw("account_read", args, async () => ({ account: await this.client.request("account/read", {}), usage: await this.client.request("account/usage/read", {}), rateLimits: await this.client.request("account/rateLimits/read", {}) })); }
  async startThread(args) { return this.#raw("start_thread", args, async () => { const result = await this.client.startThread(args.data); const threadId = result?.thread?.id; if (!threadId) throw new Error("invalid thread/start response"); return { threadId, providerRunId: threadId }; }); }
  async setGoal(args) { return this.#raw("set_goal", args, async () => { await this.client.setGoal(args.data); return { threadId: args.data.threadId, providerRunId: args.data.threadId }; }); }
  async startTurn(args) { return this.#raw("start_turn", args, async () => { const result = await this.client.startTurn(args.data); const turnId = result?.turn?.id; if (!turnId) throw new Error("invalid turn/start response"); const data = { threadId: args.data.threadId, turnId, providerRunId: `${args.data.threadId}:${turnId}` }; this.active.set(`${data.threadId}:${data.turnId}`, args.correlationId); return data; }); }
  async observeTerminal(args) { return this.#raw("observe_terminal", args, async () => { const turn = await this.client.waitForTurn(args.data.threadId, args.data.turnId, args.data.timeoutMs); const turnId = turn?.id ?? args.data.turnId; if (!terminal.has(turn?.status)) throw new Error("turn_failed"); return { threadId: args.data.threadId, turnId, providerRunId: `${args.data.threadId}:${turnId}`, terminalClass: turn.status, usage: usage(turn) }; }); }
  async readFinalResult(args) { return this.#raw("read_final_result", args, async () => { const result = await this.client.readThread({ threadId: args.data.threadId, includeTurns: true }); const turns = result?.thread?.turns ?? result?.turns ?? []; const turn = turns.find((item) => item?.id === args.data.turnId); const text = (turn?.items ?? []).filter((item) => item?.type === "agentMessage" && typeof item.text === "string").at(-1)?.text; if (!text?.trim()) throw new Error("result_unavailable"); return { threadId: args.data.threadId, turnId: args.data.turnId, providerRunId: `${args.data.threadId}:${args.data.turnId}`, resultText: text }; }); }
  async interruptTurn(args) { const key = `${args.data.threadId}:${args.data.turnId}`; if (this.interrupted.has(key)) return this.#ok("interrupt_turn", args, { threadId: args.data.threadId, turnId: args.data.turnId, providerRunId: key, terminalClass: "interrupted" }); this.interrupted.add(key); return this.#raw("interrupt_turn", args, async () => { await this.client.interruptTurn(args.data); return { threadId: args.data.threadId, turnId: args.data.turnId, providerRunId: key, terminalClass: "interrupted" }; }); }
  async shutdown(args) { if (!this.closed) { this.closed = true; await this.client.shutdown(); } return this.#ok("shutdown", args, { providerRunId: "app-server", terminalClass: "shutdown" }); }
  async diagnostics(args) { return this.#ok("diagnostics", args, { diagnostics: safeDiagnostics(this.client.diagnostics?.() ?? {}) }); }
  #notification(message) { if (message?.method === "thread/tokenUsage/updated") this.emit("usage", { contractVersion: EXECUTION_PROVIDER_VERSION, operation: "observe_terminal", correlationId: this.active.get(`${message.params?.threadId}:${message.params?.turnId}`) ?? null, success: true, data: { threadId: message.params?.threadId ?? null, turnId: message.params?.turnId ?? null, usage: usage(message.params), providerRunId: `${message.params?.threadId ?? ""}:${message.params?.turnId ?? ""}` }, diagnostics: null }); if (message?.method === "account/rateLimits/updated") this.emit("account", { contractVersion: EXECUTION_PROVIDER_VERSION, operation: "account_read", correlationId: null, success: true, data: { rateLimits: message.params?.rateLimits ?? {} }, diagnostics: null }); }
  async #raw(operation, args, fn) { try { return this.#ok(operation, args, await fn()); } catch (error) { return this.#caught(operation, args, error); } }
  #ok(operation, args, data) { return envelope({ operation, correlationId: args.correlationId, success: true, data }); }
  #failure(operation, args, errorCode, errorClass) { return envelope({ operation, correlationId: args.correlationId, success: false, errorCode, errorClass }); }
  #caught(operation, args, error) { const errorCode = String(error?.message) === "result_unavailable" ? "result_unavailable" : String(error?.message) === "turn_failed" ? "turn_failed" : codeFor(error); return envelope({ operation, correlationId: args.correlationId, success: false, errorCode, errorClass: "transport", diagnostics: error?.message }); }
}
