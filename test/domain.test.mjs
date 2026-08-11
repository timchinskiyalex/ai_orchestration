import test from "node:test";
import assert from "node:assert/strict";
import { assertTransition, finalStatusForRole } from "../src/domain.mjs";

test("task state machine permits the controlled happy path", () => {
  assert.doesNotThrow(() => assertTransition("queued", "preparing"));
  assert.doesNotThrow(() => assertTransition("preparing", "running"));
  assert.doesNotThrow(() => assertTransition("running", "awaiting_review"));
  assert.doesNotThrow(() => assertTransition("awaiting_review", "awaiting_human"));
  assert.doesNotThrow(() => assertTransition("awaiting_human", "done"));
});

test("task state machine rejects an unsafe jump", () => {
  assert.throws(() => assertTransition("queued", "done"), /Invalid task transition/);
});

test("roles complete automatically by default and retain manual workflow states when requested", () => {
  assert.equal(finalStatusForRole("planner"), "done");
  assert.equal(finalStatusForRole("planner", { autonomous: false }), "awaiting_human");
  assert.equal(finalStatusForRole("backend"), "done");
  assert.equal(finalStatusForRole("qa"), "done");
  assert.equal(finalStatusForRole("security"), "done");
});
