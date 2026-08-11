import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppServerClient } from "../src/app-server-client.mjs";
import { EventEmitter } from "node:events";
import { assertObservedParallelTurns, assertParallelWorkerSmoke, assertSingleWorkerSmoke, cleanupDisposableRoot, formatE2eDiagnostics, preserveOrCleanupDisposableRoot, withE2eTimeout } from "../src/e2e-smoke.mjs";

test("E2E timeout formatter includes bounded task lifecycle diagnostics", () => {
  const text = formatE2eDiagnostics({
    stage: "App Server worker started", taskId: "task-1", task: { threadId: "thread-1", turnId: "turn-1", status: "running", worktree: "C:/temp/worktree" }, cause: new Error("timeout"),
    runtime: {
      threadRead: { available: true, turnStatus: "inProgress" },
      lifecycleEvents: [{ type: "turn started", taskId: "task-1" }],
      appServer: { process: { alive: true, exited: false, code: null, signal: null }, protocolEvents: [{ direction: "notification", method: "item/started" }], stderrTail: "safe stderr tail" }
    }
  });
  assert.match(text, /stage=App Server worker started/);
  assert.match(text, /taskId=task-1/);
  assert.match(text, /threadId=thread-1/);
  assert.match(text, /recoveryWorktree=C:\/temp\/worktree/);
  assert.match(text, /threadRead=/);
  assert.match(text, /protocolEvents=/);
  assert.match(text, /stderrTail=safe stderr tail/);
});

test("E2E timeout stops and settles an otherwise pending operation", async () => {
  let rejectOperation;
  const operation = new Promise((_, reject) => { rejectOperation = reject; });
  await assert.rejects(withE2eTimeout({ timeoutMs: 10, operation: () => operation, onTimeout: () => rejectOperation(new Error("client closed")), diagnostics: () => "stage=worker" }), /E2E smoke timed out/);
});

test("E2E SIGINT stops and settles an otherwise pending operation", async () => {
  const signals = new EventEmitter();
  let rejectOperation;
  const operation = new Promise((_, reject) => { rejectOperation = reject; });
  const pending = withE2eTimeout({ timeoutMs: 60_000, operation: () => operation, onTimeout: () => rejectOperation(new Error("client closed")), diagnostics: () => "stage=worker", signalEmitter: signals });
  signals.emit("SIGINT");
  await assert.rejects(pending, /interrupted by SIGINT/);
});

test("single-worker smoke path excludes Bootstrap and Planner", () => {
  assert.doesNotThrow(() => assertSingleWorkerSmoke([{ role: "backend" }]));
  assert.throws(() => assertSingleWorkerSmoke([{ role: "bootstrap" }, { role: "backend" }]), /exactly one backend/);
});

test("parallel smoke requires independent backend tasks and observed overlapping turns", () => {
  assert.doesNotThrow(() => assertParallelWorkerSmoke([{ role: "backend" }, { role: "backend" }, { role: "backend" }], 3));
  assert.throws(() => assertParallelWorkerSmoke([{ role: "backend" }], 3), /exactly 3 independent backend/);
  assert.deepEqual(assertObservedParallelTurns([
    { type: "turn started", taskId: "one" },
    { type: "turn started", taskId: "two" },
    { type: "turn completed", taskId: "one" },
    { type: "turn completed", taskId: "two" }
  ]), { maximumConcurrentTurns: 2 });
  assert.throws(() => assertObservedParallelTurns([
    { type: "turn started", taskId: "one" }, { type: "turn completed", taskId: "one" },
    { type: "turn started", taskId: "two" }, { type: "turn completed", taskId: "two" }
  ]), /Expected at least 2 concurrent/);
});

test("disposable cleanup removes only a temporary root", () => {
  const root = mkdtempSync(join(tmpdir(), "orchestration-real-e2e-cleanup-"));
  writeFileSync(join(root, "marker"), "temporary", "utf8");
  cleanupDisposableRoot(root);
  assert.equal(existsSync(root), false);
});

test("failed E2E roots are preserved and unsafe cleanup targets are refused", () => {
  const root = mkdtempSync(join(tmpdir(), "orchestration-real-e2e-failed-"));
  try {
    const recovery = preserveOrCleanupDisposableRoot(root, { passed: false });
    assert.equal(existsSync(root), true);
    assert.equal(recovery.recoveryRoot, root);
    assert.match(recovery.recoveryAction, /e2e:cleanup/);
    assert.throws(() => cleanupDisposableRoot(process.cwd()), /Refuse cleanup/);
  } finally { cleanupDisposableRoot(root); }
});

test("AppServerClient shutdown rejects pending turn waiters", async () => {
  const client = new AppServerClient({ cwd: process.cwd() });
  const waiting = client.waitForTurn("thread-1", "turn-1", 60_000);
  client.shutdown();
  await assert.rejects(waiting, /App Server client closed/);
});
