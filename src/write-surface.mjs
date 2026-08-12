// Controller-owned write-surface semantics.  These scopes are security
// boundaries, so callers must never replace this with string-prefix checks.
function invalid(message) { throw new Error(`Invalid write surface: ${message}`); }

export function normalizeWriteSurface(value) {
  if (typeof value !== "string" || !value) invalid("scope must be a non-empty string");
  if (value !== value.trim()) invalid("scope must not have surrounding whitespace");
  if (/^[\\/]/.test(value)) invalid("scope must be relative, not absolute or UNC");
  if (/^[A-Za-z]:/.test(value)) invalid("scope must not be Windows drive-relative or drive-absolute");
  if (/[\0*?\[\]{}]/.test(value)) invalid("scope must not contain glob characters");
  const path = value.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!path || path === ".") invalid("scope must not be empty or root-like");
  if (path.includes("//")) invalid("scope must not contain empty path segments");
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || /[\r\n]/.test(part))) invalid("scope contains a non-canonical path segment");
  return parts.join("/");
}

export function normalizeAllowedPaths(value) {
  if (!Array.isArray(value) || !value.length) invalid("allowedPaths must be a non-empty array");
  return [...new Set(value.map(normalizeWriteSurface))].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

export function isWriteSurfaceAncestorOrSame(ancestor, candidate) {
  const left = normalizeWriteSurface(ancestor);
  const right = normalizeWriteSurface(candidate);
  return right === left || right.startsWith(`${left}/`);
}

export function writeSurfacesOverlap(left, right) {
  const leftScopes = normalizeAllowedPaths(left);
  const rightScopes = normalizeAllowedPaths(right);
  return leftScopes.some((a) => rightScopes.some((b) => isWriteSurfaceAncestorOrSame(a, b) || isWriteSurfaceAncestorOrSame(b, a)));
}

// Logical dependencies constrain the deterministic topological order but do
// not become execution dependencies.  A direct logical writer predecessor is
// separately subject to the same release contract at claim time.
export function compileWriteSurfaceTopology(tasks, { isWorkspaceWriter }) {
  if (!Array.isArray(tasks) || typeof isWorkspaceWriter !== "function") throw new Error("Execution topology requires tasks and a writer predicate");
  const byId = new Map(tasks.map((task) => [task.id, task]));
  if (byId.size !== tasks.length || [...byId.keys()].some((id) => typeof id !== "string" || !id)) throw new Error("Execution topology requires unique task ids");
  const remaining = new Map(tasks.map((task) => [task.id, new Set(task.dependsOn ?? [])]));
  for (const dependencies of remaining.values()) for (const dependency of dependencies) if (!byId.has(dependency)) throw new Error("Execution topology found an unknown logical dependency");
  const order = [];
  while (remaining.size) {
    const ready = [...remaining].filter(([, dependencies]) => !dependencies.size).map(([id]) => id).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    if (!ready.length) throw new Error("Execution topology cannot order a cyclic logical DAG");
    for (const id of ready) {
      remaining.delete(id); order.push(id);
      for (const dependencies of remaining.values()) dependencies.delete(id);
    }
  }
  const reaches = (from, target, seen = new Set()) => {
    if (from === target) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return (byId.get(from)?.dependsOn ?? []).some((dependency) => reaches(dependency, target, seen));
  };
  const writers = order.map((id) => byId.get(id)).filter(isWorkspaceWriter).map((task) => ({ ...task, allowedPaths: normalizeAllowedPaths(task.allowedPaths) }));
  const dependencies = new Map(writers.map((task) => [task.id, new Set()]));
  for (let laterIndex = 0; laterIndex < writers.length; laterIndex += 1) {
    const later = writers[laterIndex];
    for (let earlierIndex = 0; earlierIndex < laterIndex; earlierIndex += 1) {
      const earlier = writers[earlierIndex];
      if (!writeSurfacesOverlap(earlier.allowedPaths, later.allowedPaths)) continue;
      if (reaches(later.id, earlier.id) || reaches(earlier.id, later.id)) continue;
      dependencies.get(later.id).add(earlier.id);
    }
  }
  return new Map(writers.map((task) => [task.id, {
    normalizedAllowedPaths: task.allowedPaths,
    executionDependencies: [...dependencies.get(task.id)]
  }]));
}
