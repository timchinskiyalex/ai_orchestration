function fail(message) { throw new Error(`Invalid orchestration JSON: ${message}`); }
import { enforceRoutingInvariants } from "./routing-evaluator.mjs";
const domains = new Set(["backend", "frontend", "database", "qa", "security", "devops"]);
const riskFlags = new Set(["public_api_change", "auth_or_authorization", "secret_handling", "sensitive_data", "destructive_data_change", "schema_change", "production_write", "network_exposure", "permission_change", "dependency_supply_chain", "irreversible_operation", "high_blast_radius"]);

export function extractOrchestrationJson(text) {
  const match = String(text ?? "").match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (match?.[1] ?? text ?? "").trim();
  try { return JSON.parse(candidate); }
  catch { fail("agent response must contain one valid JSON object in a fenced block"); }
}

export function validateBootstrap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("bootstrap result must be an object");
  for (const key of ["summary", "assumptions", "risks", "humanGates"]) {
    if (!(key in value)) fail(`bootstrap result is missing '${key}'`);
  }
  if (typeof value.summary !== "string" || !Array.isArray(value.assumptions) || !Array.isArray(value.risks) || !Array.isArray(value.humanGates)) {
    fail("bootstrap fields have invalid types");
  }
  return value;
}

export function validatePlan(value, { maxTasks, productRoots = [] }) {
  if (!value || typeof value !== "object" || !Array.isArray(value.tasks)) fail("plan must contain a tasks array");
  if (!value.tasks.length) fail("plan must contain at least one task");
  if (value.tasks.length > maxTasks) fail(`plan exceeds configured maxPlanTasks (${maxTasks})`);
  const ids = new Set();
  for (const task of value.tasks) {
    if (!task || typeof task !== "object") fail("every task must be an object");
    for (const key of ["id", "title", "prompt", "primaryDomain", "supportingDomains", "riskFlags", "estimatedTokens", "dependsOn", "allowedPaths", "acceptanceChecks", "humanApprovalRequired"]) {
      if (!(key in task)) fail(`task is missing '${key}'`);
    }
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(task.id)) fail(`task id '${task.id}' is unsafe`);
    if (ids.has(task.id)) fail(`task id '${task.id}' is duplicated`);
    ids.add(task.id);
    if (typeof task.title !== "string" || typeof task.prompt !== "string" || !task.title.trim() || !task.prompt.trim()) fail(`task '${task.id}' needs title and prompt`);
    if (![task.supportingDomains, task.riskFlags, task.dependsOn, task.allowedPaths, task.acceptanceChecks].every(Array.isArray)) fail(`task '${task.id}' array fields are invalid`);
    if (!domains.has(task.primaryDomain) || task.supportingDomains.some((domain) => !domains.has(domain))) fail(`task '${task.id}' has an unknown domain`);
    if (task.riskFlags.some((flag) => !riskFlags.has(flag))) fail(`task '${task.id}' has an unknown risk flag`);
    if (!Number.isInteger(task.estimatedTokens) || task.estimatedTokens < 1) fail(`task '${task.id}' needs a positive token estimate`);
    if (typeof task.humanApprovalRequired !== "boolean") fail(`task '${task.id}' needs humanApprovalRequired boolean`);
  }
  for (const task of value.tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency) || dependency === task.id) fail(`task '${task.id}' has an invalid dependency '${dependency}'`);
    }
  }
  if (productRoots.length) {
    const scaffold = value.tasks.find((task) => task.id === "scaffold-product");
    if (!scaffold) fail("greenfield multi-stack plan requires a scaffold-product task");
    if (scaffold.primaryDomain !== "devops") fail("scaffold-product must be a devops writer task");
    const roots = productRoots.map((item) => item.path);
    if (!roots.every((root) => scaffold.allowedPaths.includes(root))) fail("scaffold-product must be allowed to create every declared product root");
    for (const task of value.tasks) {
      if (task.id === scaffold.id) continue;
      const writesProduct = task.allowedPaths.some((path) => roots.some((root) => path === root || path.startsWith(`${root}/`)));
      if (writesProduct && !task.dependsOn.includes(scaffold.id)) fail(`product task '${task.id}' must directly depend on scaffold-product`);
    }
  }
  const visiting = new Set();
  const visited = new Set();
  const byId = new Map(value.tasks.map((task) => [task.id, task]));
  const visit = (id) => {
    if (visiting.has(id)) fail("plan dependency graph contains a cycle");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id).dependsOn) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const task of value.tasks) visit(task.id);
  try { return enforceRoutingInvariants(value); }
  catch (error) { fail(error.message.replace(/^Unsafe routing plan: /, "")); }
}
