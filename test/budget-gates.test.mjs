import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SwarmRouter } from "../src/router.mjs";

function config(root) {
  const roles = Object.fromEntries(["bootstrap", "planner", "backend", "frontend", "database", "qa", "security", "devops"].map((role) => [role, { sandbox: "read-only", approvalPolicy: "never", tokenBudget: 100, maxAttempts: 1, usesWorktree: false }]));
  return { repository: root, runtimeDir: join(root, "runtime"), baseRef: "main", model: "test", project: { name: "test", documentationDir: "docs/in", generatedDir: "docs/out" }, router: { maxConcurrentTasks: 10, maxChildrenPerTask: 20, maxDelegationDepth: 4, maxPlanTasks: 12, defaultParentBudget: 1000, turnTimeoutMs: 1000, approvalMode: "deny" }, budget: { weeklyTokenLimit: 50, weeklyWindowDays: 7 }, quota: { throttleAtUsedPercent: 90, throttleWhenUnavailable: false }, roles };
}

test("P90 hard gate requires separately recorded human override", () => {
  const root = mkdtempSync(join(tmpdir(), "budget-gate-")); const router = new SwarmRouter(config(root));
  try {
    const planner = router.enqueue({ role: "planner", title: "Plan", prompt: "plan" });
    router.store.transition(planner.id, "preparing"); router.store.transition(planner.id, "running"); router.store.transition(planner.id, "awaiting_human");
    router.enqueue({ role: "backend", parentTaskId: planner.id, title: "Work", prompt: "work", dependencies: [planner.id], allowedPaths: ["src"], estimatedTokens: 100 });
    assert.throws(() => router.approveHumanGate(planner.id), /separate budget override/);
    assert.throws(() => router.overrideBudgetGate(planner.id, "short"), /specific human reason/);
    router.overrideBudgetGate(planner.id, "Pilot owner accepts the forecasted local budget exposure.");
    assert.equal(router.approveHumanGate(planner.id).shouldRun, true);
  } finally { router.close(); rmSync(root, { recursive: true, force: true }); }
});

test("quota throttle blocks scheduler capacity even when maxConcurrentTasks is ten", () => {
  const root = mkdtempSync(join(tmpdir(), "quota-gate-")); const router = new SwarmRouter(config(root));
  try {
    router.store.recordAccountSnapshot({ schemaVersion: 2, capturedAt: new Date().toISOString(), account: { availability: "available" }, accountActivity: [], rateLimitBuckets: {}, quotaWindows: [{ limitId: "codex", limitName: "Codex", window: "primary", usedPercent: 95, windowDurationMins: 300, resetsAt: 1 }], diagnostics: [] });
    const status = router.quotaThrottleStatus();
    assert.equal(router.config.router.maxConcurrentTasks, 10);
    assert.equal(status.throttled, true);
    assert.equal(status.windows[0].limitId, "codex");
  } finally { router.close(); rmSync(root, { recursive: true, force: true }); }
});

test("run-to-integration refuses to bypass pending human gates", async () => {
  const root = mkdtempSync(join(tmpdir(), "manual-flow-")); const router = new SwarmRouter(config(root));
  try {
    const task = router.enqueue({ role: "backend", title: "Sensitive", prompt: "work", allowedPaths: ["src"], humanApprovalRequired: true });
    router.store.transition(task.id, "awaiting_human");
    await assert.rejects(router.runToIntegration(), /refuses to bypass human gates/);
  } finally { router.close(); rmSync(root, { recursive: true, force: true }); }
});

test("human-approved tasks are never initially claimable and an App Server approval can be resumed", () => {
  const root = mkdtempSync(join(tmpdir(), "human-gate-")); const router = new SwarmRouter(config(root));
  try {
    const task = router.enqueue({ role: "backend", title: "Guarded", prompt: "work", allowedPaths: ["src"], humanApprovalRequired: true });
    assert.equal(router.store.getTask(task.id).status, "awaiting_human");
    assert.equal(router.store.claimNext(), null, "a human gate must not be claimable as queued work");
    assert.equal(router.approveHumanGate(task.id).shouldRun, true);
    assert.equal(router.store.getTask(task.id).status, "queued");

    router.store.transition(task.id, "preparing"); router.store.transition(task.id, "running"); router.store.transition(task.id, "awaiting_approval");
    const resumed = router.approveHumanGate(task.id);
    assert.equal(resumed.resumedApproval, true);
    assert.equal(router.store.getTask(task.id).status, "queued");
  } finally { router.close(); rmSync(root, { recursive: true, force: true }); }
});
