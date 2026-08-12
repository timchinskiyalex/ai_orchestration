// Controller-owned, in-process execution boundary.  This deliberately has no
// discovery or selection mechanism: App Server is the only production adapter.
export const EXECUTION_PROVIDER_VERSION = "execution-provider/v1";

export const REQUIRED_EXECUTION_CAPABILITIES = Object.freeze([
  "lifecycle_completion", "final_result_read", "idempotent_interrupt",
  "usage_updates", "account_reads", "bounded_diagnostics"
]);

export const EXECUTION_OPERATIONS = Object.freeze([
  "handshake", "account_read", "start_thread", "set_goal", "start_turn",
  "observe_terminal", "read_final_result", "interrupt_turn", "shutdown", "diagnostics"
]);

export class ExecutionProviderError extends Error {
  constructor(errorCode, message = errorCode, details = {}) {
    super(`${errorCode}: ${message}`); this.name = "ExecutionProviderError"; this.errorCode = errorCode;
    this.errorClass = details.errorClass ?? "protocol"; this.diagnostics = details.diagnostics ?? null;
  }
}

export const safeDiagnostics = (value) => {
  if (value == null) return null;
  const text = JSON.stringify(value).replace(/((?:api[_-]?key|token|secret|password|authorization|cookie|private[_-]?key)\s*[:=]\s*)[^\s,;\"]+/gi, "$1[redacted]");
  return text.slice(0, 2000);
};

export function envelope({ operation, correlationId, success, data = null, errorCode = null, errorClass = null, diagnostics = null }) {
  return { contractVersion: EXECUTION_PROVIDER_VERSION, operation, correlationId, success, ...(success ? { data } : { errorCode, errorClass }), diagnostics: safeDiagnostics(diagnostics) };
}

export function validateEnvelope(value, { operation, correlationId, requiredIds = [] } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ExecutionProviderError("invalid_envelope", "provider returned no valid envelope");
  if (value.contractVersion !== EXECUTION_PROVIDER_VERSION) throw new ExecutionProviderError("unsupported_contract_version", "provider contract version is unsupported");
  if (value.operation !== operation) throw new ExecutionProviderError("protocol_violation", `provider operation mismatch: expected ${operation}`);
  if (value.correlationId !== correlationId) throw new ExecutionProviderError("correlation_mismatch", "provider did not echo controller correlation id");
  if (typeof value.success !== "boolean") throw new ExecutionProviderError("invalid_envelope", "provider envelope lacks success boolean");
  if (!value.success) {
    if (typeof value.errorCode !== "string" || typeof value.errorClass !== "string") throw new ExecutionProviderError("invalid_envelope", "provider failure lacks typed error");
    throw new ExecutionProviderError(value.errorCode, value.errorCode, { errorClass: value.errorClass, diagnostics: value.diagnostics });
  }
  if (!Object.hasOwn(value, "data") || !value.data || typeof value.data !== "object") throw new ExecutionProviderError("invalid_envelope", "provider success lacks normalized data");
  for (const id of requiredIds) if (typeof value.data[id] !== "string" || !value.data[id]) throw new ExecutionProviderError("invalid_envelope", `provider success lacks ${id}`);
  return value.data;
}

export function assertCapabilities(data) {
  const capabilities = data?.capabilities;
  if (!Array.isArray(capabilities)) throw new ExecutionProviderError("invalid_envelope", "handshake lacks capabilities");
  for (const capability of REQUIRED_EXECUTION_CAPABILITIES) if (!capabilities.includes(capability)) throw new ExecutionProviderError("unsupported_capability", `provider lacks ${capability}`);
  const prohibited = ["workspace_management", "state_transition", "artifacts", "integration", "publication", "merge"];
  if (capabilities.some((capability) => prohibited.includes(capability))) throw new ExecutionProviderError("unsupported_capability", "provider advertises controller authority");
  return capabilities;
}
