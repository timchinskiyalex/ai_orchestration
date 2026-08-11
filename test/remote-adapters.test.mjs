import test from "node:test";
import assert from "node:assert/strict";
import { PullRequestAdapter, RemoteCiAdapter, RemoteGitAdapter, assertSafeRemoteTarget } from "../src/remote-adapters.mjs";

test("RemoteGitAdapter requires confirmation, allowlisted remote, candidate prefix, and safe branch", async () => {
  const calls = [];
  const adapter = new RemoteGitAdapter({ repository: "C:/repo", remoteName: "origin", allowedRemotes: ["origin"], branchPrefix: "swarm/candidate/", execute: async (...args) => calls.push(args) });
  await assert.rejects(adapter.pushCandidate({ branch: "swarm/candidate/a", sha: "a".repeat(40), idempotencyKey: "k" }), /confirm/);
  await assert.rejects(adapter.pushCandidate({ branch: "main", sha: "a".repeat(40), confirmRemotePush: true, idempotencyKey: "k" }), /protected/);
  await adapter.pushCandidate({ branch: "swarm/candidate/a", sha: "a".repeat(40), confirmRemotePush: true, idempotencyKey: "k" });
  assert.equal(calls.length, 1); assert.deepEqual(calls[0][1].slice(-2), ["origin", `${"a".repeat(40)}:refs/heads/swarm/candidate/a`]);
  assert.throws(() => assertSafeRemoteTarget({ remoteName: "evil", branch: "swarm/candidate/a", allowedRemotes: ["origin"] }), /allowlisted/);
});

test("missing remote CI and PR adapters report human handoff instead of success", async () => {
  assert.equal((await new RemoteCiAdapter().verify({})).status, "unavailable");
  assert.equal((await new PullRequestAdapter().handoff({})).status, "unavailable");
});
