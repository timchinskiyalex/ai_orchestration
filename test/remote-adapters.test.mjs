import test from "node:test";
import assert from "node:assert/strict";
import { GitHubCiAdapter, PullRequestAdapter, RemoteCiAdapter, RemoteGitAdapter, assertSafeRemoteTarget } from "../src/remote-adapters.mjs";

test("RemoteGitAdapter verifies exact SHA without force-push and refuses unsafe targets", async () => {
  const calls = []; let pushed = false; const sha = "a".repeat(40);
  const adapter = new RemoteGitAdapter({ repository: "C:/repo", remoteName: "origin", allowedRemotes: ["origin"], branchPrefix: "swarm/candidate/", execute: async (...args) => { calls.push(args); if (args[1].includes("push")) pushed = true; return { stdout: args[1].includes("ls-remote") && pushed ? `${sha}\trefs/heads/swarm/candidate/a\n` : "" }; } });
  await assert.rejects(adapter.pushCandidate({ branch: "swarm/candidate/a", sha, confirmRemotePush: false, idempotencyKey: "k" }), /disabled/);
  await assert.rejects(adapter.pushCandidate({ branch: "main", sha: "a".repeat(40), confirmRemotePush: true, idempotencyKey: "k" }), /protected/);
  await adapter.pushCandidate({ branch: "swarm/candidate/a", sha, idempotencyKey: "k" });
  assert.equal(calls.length, 3); assert.deepEqual(calls[1][1].slice(-2), ["origin", `${sha}:refs/heads/swarm/candidate/a`]);
  assert.throws(() => assertSafeRemoteTarget({ remoteName: "evil", branch: "swarm/candidate/a", allowedRemotes: ["origin"] }), /allowlisted/);
});

test("missing remote CI and PR adapters report human handoff instead of success", async () => {
  assert.equal((await new RemoteCiAdapter().verify({})).status, "unavailable");
  assert.equal((await new PullRequestAdapter().handoff({})).status, "unavailable");
});

function githubForChecks({ runs = [], statuses = [] }) { return { async repositoryName() { return "owner/repo"; }, async api(args) { const path = args.at(-1); if (path.includes("check-runs")) return { stdout: JSON.stringify({ check_runs: runs }) }; if (path.endsWith("/status")) return { stdout: JSON.stringify({ sha: "a".repeat(40), statuses }) }; throw new Error(`Unexpected GitHub API request: ${path}`); } }; }

test("required CI contexts are evaluated only for the exact candidate SHA", async () => {
  const candidate = { sha: "a".repeat(40), base: "main" }; const check = (name, status, conclusion = null, headSha = candidate.sha) => ({ name, status, conclusion, head_sha: headSha });
  const verify = async (fixture) => new GitHubCiAdapter({ github: githubForChecks(fixture), requiredContexts: ["build"], timeoutMs: 1, pollIntervalMs: 1 }).waitForChecks({ pullRequest: { number: 7 }, candidate });
  const unrelated = await verify({ runs: [check("unrelated", "completed", "success")] }); assert.equal(unrelated.status, "timed_out"); assert.equal(unrelated.required[0].state, "missing");
  const pending = await verify({ runs: [check("build", "in_progress", null)] }); assert.equal(pending.status, "timed_out"); assert.equal(pending.required[0].state, "pending");
  const failed = await verify({ runs: [check("build", "completed", "failure")] }); assert.equal(failed.status, "failed");
  const stale = await verify({ runs: [check("build", "completed", "success", "b".repeat(40))] }); assert.equal(stale.status, "timed_out"); assert.equal(stale.required[0].state, "missing");
  const passed = await verify({ runs: [check("build", "completed", "success")] }); assert.equal(passed.status, "passed"); assert.deepEqual(passed.requiredContexts, ["build"]);
});
