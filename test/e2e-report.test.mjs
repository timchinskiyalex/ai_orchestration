import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createE2eRunReporter, readLatestE2eReport } from "../src/e2e-report.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

test("live E2E launcher refuses to spend quota without the explicit confirmation flag", () => {
  const result = spawnSync(process.execPath, ["scripts/e2e-live.mjs"], { cwd: root, encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--confirm-spend-quota/);
});

test("E2E reporter creates a safe run directory, updates latest, and finalizes failure", () => {
  const reportsRoot = mkdtempSync(join(tmpdir(), "e2e-reports-"));
  try {
    const reporter = createE2eRunReporter({ reportsRoot, runId: "run-1" });
    reporter.event("thread started", { taskId: "task-1", threadId: "thread-1", prompt: "SECRET PROMPT", rawPayload: { secret: "value" }, tokenUsage: { totalTokens: 12, text: "hidden" } });
    const error = new Error("integration token=top-secret failed");
    error.code = "INTEGRATION_FAILED";
    error.stdout = "stdout token=top-secret";
    error.stderr = "stderr secret=top-secret";
    reporter.finalize({
      status: "failed", task: { id: "task-1", status: "failed", threadId: "thread-1", turnId: "turn-1", prompt: "do not retain" }, error,
      artifact: { taskId: "task-1", headSha: "abc123", path: "docs/orchestration-generated/worker-artifacts/task-1.v1.json" },
      integration: { path: "docs/orchestration-generated/integration-manifests/blocked.json", manifest: { status: "CONFLICT_BLOCKED", blockedReason: "overlapping migration", worktree: "C:/temp/integration" } }
    });
    assert.equal(existsSync(join(reportsRoot, "run-1", "events.jsonl")), true);
    assert.equal(existsSync(join(reportsRoot, "run-1", "summary.json")), true);
    const output = `${readFileSync(join(reportsRoot, "run-1", "events.jsonl"), "utf8")}${readFileSync(join(reportsRoot, "run-1", "summary.json"), "utf8")}`;
    assert.doesNotMatch(output, /SECRET PROMPT|rawPayload|do not retain|top-secret/);
    assert.match(output, /"totalTokens":12/);
    const latest = readLatestE2eReport(reportsRoot);
    assert.equal(latest.status, "failed");
    assert.equal(latest.runId, "run-1");
    assert.equal(latest.resultPath.endsWith("summary.json"), true);
    assert.equal(latest.error.code, "INTEGRATION_FAILED");
    assert.match(latest.error.message, /token=\[redacted\]/);
    assert.equal(latest.integration.status, "CONFLICT_BLOCKED");
    assert.equal(latest.integration.blockedReason, "overlapping migration");
    assert.equal(latest.artifact.path, "docs/orchestration-generated/worker-artifacts/task-1.v1.json");
  } finally { rmSync(reportsRoot, { recursive: true, force: true }); }
});

test("template .gitignore excludes persistent E2E reports", () => {
  execFileSync("git", ["-C", root, "check-ignore", "-q", "runtime/e2e-runs/example/summary.json"]);
});
