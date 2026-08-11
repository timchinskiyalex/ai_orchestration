export const ENGINEERING_DOMAINS = new Set(["backend", "frontend", "database", "qa", "security", "devops"]);
export const ROLES = new Set(["bootstrap", "planner", ...ENGINEERING_DOMAINS]);

export const TERMINAL_STATUSES = new Set(["done", "failed", "cancelled", "blocked_budget", "interrupted"]);

const transitions = {
  queued: new Set(["preparing", "awaiting_human", "cancelled", "blocked_budget", "interrupted"]),
  preparing: new Set(["running", "failed", "cancelled", "blocked_budget", "interrupted"]),
  running: new Set(["awaiting_approval", "awaiting_review", "awaiting_human", "done", "failed", "cancelled", "blocked_budget", "interrupted"]),
  awaiting_approval: new Set(["queued", "cancelled", "failed", "interrupted"]),
  awaiting_review: new Set(["queued", "awaiting_human", "done", "failed", "cancelled", "interrupted"]),
  awaiting_human: new Set(["queued", "done", "failed", "cancelled", "interrupted"]),
  blocked_budget: new Set(["queued", "cancelled", "interrupted"]),
  failed: new Set(["queued", "cancelled"]),
  done: new Set(),
  cancelled: new Set(),
  interrupted: new Set()
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

export function finalStatusForRole(role, { autonomous = true } = {}) {
  if (!autonomous && (role === "bootstrap" || role === "planner")) return "awaiting_human";
  return "done";
}
