export const ENGINEERING_DOMAINS = new Set(["backend", "frontend", "database", "qa", "security", "devops"]);
export const ROLES = new Set(["bootstrap", "planner", ...ENGINEERING_DOMAINS]);

export const TERMINAL_STATUSES = new Set(["done", "failed", "cancelled"]);

const transitions = {
  queued: new Set(["preparing", "awaiting_human", "cancelled", "blocked_budget"]),
  preparing: new Set(["running", "failed", "cancelled", "blocked_budget"]),
  running: new Set(["awaiting_approval", "awaiting_review", "awaiting_human", "done", "failed", "cancelled", "blocked_budget"]),
  awaiting_approval: new Set(["queued", "cancelled", "failed"]),
  awaiting_review: new Set(["queued", "awaiting_human", "done", "failed", "cancelled"]),
  awaiting_human: new Set(["queued", "done", "failed", "cancelled"]),
  blocked_budget: new Set(["queued", "cancelled"]),
  failed: new Set(["queued", "cancelled"]),
  done: new Set(),
  cancelled: new Set()
};

export function assertRole(role) {
  if (!ROLES.has(role)) throw new Error(`Unknown role: ${role}`);
}

export function canTransition(from, to) {
  return transitions[from]?.has(to) ?? false;
}

export function assertTransition(from, to) {
  if (!canTransition(from, to)) throw new Error(`Invalid task transition: ${from} → ${to}`);
}

export function depthOf(task, taskById) {
  let depth = 0;
  let cursor = task;
  const visited = new Set();
  while (cursor.parentTaskId) {
    if (visited.has(cursor.id)) throw new Error(`Task parent cycle detected at ${cursor.id}`);
    visited.add(cursor.id);
    cursor = taskById(cursor.parentTaskId);
    if (!cursor) throw new Error(`Missing parent task: ${task.parentTaskId}`);
    depth += 1;
  }
  return depth;
}

export function finalStatusForRole(role) {
  if (role === "bootstrap") return "awaiting_human";
  if (role === "planner") return "awaiting_human";
  return "done";
}
