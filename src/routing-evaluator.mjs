const securityFlags = new Set(["auth_or_authorization", "secret_handling", "sensitive_data", "network_exposure", "permission_change", "dependency_supply_chain"]);
const databaseFlags = new Set(["schema_change", "destructive_data_change", "irreversible_operation"]);

export function enforceRoutingInvariants(plan) {
  const errors = [];
  for (const task of plan.tasks ?? []) {
    const flags = new Set(task.riskFlags ?? []);
    const supporting = new Set(task.supportingDomains ?? []);
    if ([...flags].some((flag) => securityFlags.has(flag)) && task.primaryDomain !== "security" && !supporting.has("security")) errors.push(`${task.id}: security gate is mandatory for declared risk flags`);
    if ([...flags].some((flag) => databaseFlags.has(flag))) {
      if (task.primaryDomain !== "database") errors.push(`${task.id}: database domain is mandatory for schema/destructive work`);
      if (!task.humanApprovalRequired) errors.push(`${task.id}: humanApprovalRequired is mandatory for schema/destructive work`);
    }
    if (flags.has("permission_change") && task.primaryDomain !== "devops") errors.push(`${task.id}: devops domain is mandatory for permission changes`);
    if (task.primaryDomain === "devops" && flags.has("permission_change") && !supporting.has("security")) errors.push(`${task.id}: devops permission changes require security`);
    if (!Array.isArray(task.allowedPaths) || !task.allowedPaths.length) errors.push(`${task.id}: allowedPaths must be explicit; ambiguous changes are rejected`);
  }
  if (errors.length) throw new Error(`Unsafe routing plan: ${errors.join("; ")}`);
  return plan;
}

export function gradeRoutingFixture({ plan, expected }) {
  try {
    enforceRoutingInvariants(plan);
    const domains = new Set(plan.tasks.flatMap((task) => [task.primaryDomain, ...(task.supportingDomains ?? [])]));
    for (const domain of expected.domains ?? []) if (!domains.has(domain)) return { passed: false, reason: `missing domain ${domain}` };
    return { passed: expected.valid !== false, reason: expected.valid === false ? "expected rejection but accepted" : "accepted" };
  } catch (error) { return { passed: expected.valid === false, reason: error.message }; }
}
