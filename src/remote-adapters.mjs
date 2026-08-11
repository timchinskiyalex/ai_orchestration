import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const protectedBranches = new Set(["main", "master"]);
const safeName = (value) => typeof value === "string" && /^[A-Za-z0-9._/-]+$/.test(value) && !value.includes("..");

export function assertSafeRemoteTarget({ remoteName, branch, allowedRemotes = [], branchPrefix = "swarm/candidate/" }) {
  if (!safeName(remoteName) || !allowedRemotes.includes(remoteName)) throw new Error("Remote is not allowlisted");
  if (!safeName(branch) || protectedBranches.has(branch.toLowerCase())) throw new Error("Refuse protected or unsafe remote branch");
  if (!branch.startsWith(branchPrefix)) throw new Error("Remote branch is outside the configured candidate prefix");
}

export class RemoteGitAdapter {
  constructor({ repository, remoteName, allowedRemotes, branchPrefix, execute = exec } = {}) {
    this.repository = repository; this.remoteName = remoteName; this.allowedRemotes = allowedRemotes ?? []; this.branchPrefix = branchPrefix ?? "swarm/candidate/"; this.execute = execute;
  }
  async pushCandidate({ branch, sha, confirmRemotePush, idempotencyKey }) {
    if (!confirmRemotePush) throw new Error("Remote push requires explicit --confirm-remote-push");
    assertSafeRemoteTarget({ remoteName: this.remoteName, branch, allowedRemotes: this.allowedRemotes, branchPrefix: this.branchPrefix });
    if (!/^[0-9a-f]{7,64}$/i.test(sha)) throw new Error("Candidate SHA is invalid");
    if (!idempotencyKey) throw new Error("Remote push requires an idempotency key");
    await this.execute("git", ["-C", this.repository, "push", this.remoteName, `${sha}:refs/heads/${branch}`], { windowsHide: true });
    return { status: "pushed", remoteName: this.remoteName, branch, sha, idempotencyKey };
  }
}

export class RemoteCiAdapter {
  constructor({ check = null } = {}) { this.check = check; }
  async verify(candidate) {
    if (!this.check) return { status: "unavailable", reason: "No RemoteCiAdapter configured; no remote CI action was attempted" };
    return this.check(candidate);
  }
}

export class PullRequestAdapter {
  constructor({ create = null } = {}) { this.create = create; }
  async handoff(candidate) {
    if (!this.create) return { status: "unavailable", reason: "No PullRequestAdapter configured; explicit human remote handoff is required" };
    return this.create(candidate);
  }
}
