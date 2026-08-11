import test from "node:test";
import assert from "node:assert/strict";
import { PullRequestAdapter, RemoteCiAdapter, RemoteGitAdapter, assertSafeRemoteTarget } from "../src/remote-adapters.mjs";

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
