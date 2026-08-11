import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { runManagedProcess } from "../src/managed-process-runner.mjs";

function fakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter(); child.stdout.destroy = () => {};
  child.stderr = new EventEmitter(); child.stderr.destroy = () => {};
  child.unref = () => {};
  child.kill = () => {};
  return child;
}

test("Windows timeout starts taskkill for the full process tree and rejects without waiting for child close", async () => {
  const calls = []; const stuck = fakeChild(8123);
  const spawnProcess = (executable, args, options) => {
    calls.push({ executable, args, options });
    if (executable === "taskkill") { const killer = fakeChild(9001); queueMicrotask(() => killer.emit("close", 0, null)); return killer; }
    return stuck;
  };
  const started = Date.now();
  await assert.rejects(
    runManagedProcess({ executable: "npm", args: ["run", "test"], cwd: "C:\\safe", timeoutMs: 15, platform: "win32", spawnProcess }),
    (error) => error.timedOut === true && error.termination?.command === "taskkill"
  );
  assert.ok(Date.now() - started < 500, "the controller must not wait for the stuck child close event");
  assert.deepEqual(calls[0], { executable: "npm", args: ["run", "test"], options: { cwd: "C:\\safe", windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] } });
  assert.deepEqual(calls[1].args, ["/PID", "8123", "/T", "/F"]);
  assert.equal(calls[1].options.shell, false);
});

test("managed runner retains bounded stdout and exact argument vector", async () => {
  const child = fakeChild(55);
  const promise = runManagedProcess({ executable: "dotnet", args: ["test", "Backend.sln"], cwd: "C:\\safe", maxOutputBytes: 4, spawnProcess: () => child });
  child.stdout.emit("data", "123456"); child.stderr.emit("data", "abcdef"); child.emit("close", 0, null);
  const result = await promise;
  assert.equal(result.stdout, "3456"); assert.equal(result.stderr, "cdef"); assert.deepEqual(result.args, ["test", "Backend.sln"]);
});
