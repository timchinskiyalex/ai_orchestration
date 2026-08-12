import test from "node:test";
import assert from "node:assert/strict";
import { deliveryExitCode, deliveryFinalSummary } from "../src/delivery-presentation.mjs";

test("only completed_merged has a zero delivery exit code and summary retains recovery context", () => {
  const terminal = ["completed_merged", "failed", "conflict_blocked", "interrupted", "blocked_budget", "blocked_quota", "blocked_credentials", "blocked_ci", "blocked_branch_protection", "completed_candidate_ready"];
  for (const state of terminal) assert.equal(deliveryExitCode({ state }), 1, state);
  assert.equal(deliveryExitCode({ state: "completed_merged", completionContractVersion: 2, publish: { acceptanceReportId: "acceptance" } }), 0);
  const router = { statusSnapshot() { return { tasks: [{ status: "done", remediationRound: 0 }, { status: "blocked_ci", remediationRound: 1 }], qualityReports: [{ report: { verdict: "pass" } }], securityReports: [{ report: { verdict: "pass" } }], localBudget: { usedTokens: 5 }, deliveryRun: { candidate: { branch: "swarm/candidate/a", sha: "a".repeat(40) }, publicationCheckpoint: { stage: "ci" } } }; } };
  const summary = deliveryFinalSummary(router, { state: "blocked_ci", integrationPath: "runtime/integration.json", publish: { recovery: { action: "resume" } } });
  assert.equal(summary.terminalState, "blocked_ci"); assert.equal(summary.taskStages.blocked, 1); assert.equal(summary.remediation, 1); assert.equal(summary.recoveryAction, "resume"); assert.equal(summary.artifacts.publicationCheckpoint.stage, "ci");
});
