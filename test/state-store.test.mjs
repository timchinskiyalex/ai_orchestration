import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../src/state-store.mjs";

test("state store claims, transitions and records usage", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-swarm-store-"));
  const store = new StateStore(join(dir, "state.sqlite"));
  try {
    store.createTask({ id: "task-1", role: "planner", title: "Plan", prompt: "Plan safely", tokenBudget: 100, maxAttempts: 1 });
    const claimed = store.claimNext();
    assert.equal(claimed.status, "preparing");
    store.transition("task-1", "running");
    store.setThread("task-1", { threadId: "thr-1", turnId: "turn-1" });
    store.setTokenUsage("task-1", 42);
    assert.equal(store.getTask("task-1").tokenUsed, 42);
    store.transition("task-1", "done");
    assert.equal(store.getTask("task-1").status, "done");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("state store does not claim a task before its dependencies finish", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-swarm-dependencies-"));
  const store = new StateStore(join(dir, "state.sqlite"));
  try {
    store.createTask({ id: "first", role: "planner", title: "First", prompt: "First", tokenBudget: 100, maxAttempts: 1 });
    store.createTask({ id: "second", role: "backend", title: "Second", prompt: "Second", dependencies: ["first"], tokenBudget: 100, maxAttempts: 1 });
    assert.equal(store.claimNext().id, "first");
    store.transition("first", "running");
    store.transition("first", "done");
    assert.equal(store.claimNext().id, "second");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
