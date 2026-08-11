import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const protectedBranches = new Set(["main", "master"]);
const safeName = (value) => typeof value === "string" && /^[A-Za-z0-9._/-]+$/.test(value) && !value.includes("..");
const isCredentialError = (error) => /(?:gh auth|not logged|authentication|credentials?|token|http 401|http 403)/i.test(String(error?.message ?? error));
const compactError = (error) => String(error?.stderr || error?.message || error).replace(/\s+/g, " ").slice(0, 500);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class RemoteAdapterError extends Error {
  constructor(code, message, cause = null) { super(message); this.name = "RemoteAdapterError"; this.code = code; this.cause = cause; }
}

export function assertSafeRemoteTarget({ remoteName, branch, allowedRemotes = [], branchPrefix = "swarm/candidate/" }) {
  if (!safeName(remoteName) || !allowedRemotes.includes(remoteName)) throw new Error("Remote is not allowlisted");
  if (!safeName(branch) || protectedBranches.has(branch.toLowerCase())) throw new Error("Refuse protected or unsafe remote branch");
  if (!branch.startsWith(branchPrefix)) throw new Error("Remote branch is outside the configured candidate prefix");
}

export class RemoteGitAdapter {
  constructor({ repository, remoteName, allowedRemotes, branchPrefix, execute = exec } = {}) {
    this.repository = repository; this.remoteName = remoteName; this.allowedRemotes = allowedRemotes ?? []; this.branchPrefix = branchPrefix ?? "swarm/candidate/"; this.execute = execute;
  }

  async pushCandidate({ branch, sha, confirmRemotePush = true, idempotencyKey }) {
    if (!confirmRemotePush) throw new Error("Remote push is disabled by policy");
    assertSafeRemoteTarget({ remoteName: this.remoteName, branch, allowedRemotes: this.allowedRemotes, branchPrefix: this.branchPrefix });
    if (!/^[0-9a-f]{7,64}$/i.test(sha)) throw new Error("Candidate SHA is invalid");
    if (!idempotencyKey) throw new Error("Remote push requires an idempotency key");
    const ref = `refs/heads/${branch}`;
    try {
      const before = await this.execute("git", ["-C", this.repository, "ls-remote", "--refs", this.remoteName, ref], { windowsHide: true });
      const existingSha = String(before.stdout ?? "").trim().split(/\s+/)[0] || null;
      if (existingSha && existingSha.toLowerCase() !== sha.toLowerCase()) throw new RemoteAdapterError("remote_sha_mismatch", `Candidate branch '${branch}' already exists at an unexpected SHA; refusing to overwrite it.`);
      if (!existingSha) await this.execute("git", ["-C", this.repository, "push", this.remoteName, `${sha}:${ref}`], { windowsHide: true });
      const after = await this.execute("git", ["-C", this.repository, "ls-remote", "--refs", this.remoteName, ref], { windowsHide: true });
      const actualSha = String(after.stdout ?? "").trim().split(/\s+/)[0] || null;
      if (actualSha?.toLowerCase() !== sha.toLowerCase()) throw new RemoteAdapterError("remote_sha_mismatch", `Remote candidate SHA verification failed for '${branch}'.`);
      return { status: "pushed", remoteName: this.remoteName, branch, sha, verifiedSha: actualSha, idempotencyKey, duplicate: Boolean(existingSha) };
    } catch (error) {
      if (error instanceof RemoteAdapterError) throw error;
      if (isCredentialError(error)) throw new RemoteAdapterError("credentials", "Git remote credentials are unavailable or invalid.", error);
      throw new RemoteAdapterError("push_failed", `Candidate push failed: ${compactError(error)}`, error);
    }
  }
}

export class GitHubAdapter {
  constructor({ repository, execute = exec } = {}) { this.repository = repository; this.execute = execute; this.repo = null; }

  async #gh(args, options = {}) {
    try { return await this.execute("gh", args, { cwd: this.repository, windowsHide: true, ...options }); }
    catch (error) {
      if (isCredentialError(error)) throw new RemoteAdapterError("credentials", "GitHub CLI credentials are unavailable or invalid.", error);
      throw error;
    }
  }

  async assertAuthenticated() {
    await this.#gh(["auth", "status"]);
    return true;
  }

  async repositoryName() {
    if (this.repo) return this.repo;
    await this.assertAuthenticated();
    const result = await this.#gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
    const name = String(result.stdout ?? "").trim();
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(name)) throw new RemoteAdapterError("repository", "GitHub CLI did not return an allowlisted repository name.");
    this.repo = name;
    return name;
  }

  async api(args) { return this.#gh(["api", ...args]); }
}

export class GitHubPullRequestAdapter {
  constructor({ repository, github = null, execute = exec } = {}) { this.github = github ?? new GitHubAdapter({ repository, execute }); }

  async ensurePullRequest({ branch, base, sha, idempotencyKey, title = null, body = null }) {
    if (!safeName(branch) || protectedBranches.has(branch.toLowerCase()) || !safeName(base) || branch === base) throw new Error("Unsafe pull request branch");
    if (!idempotencyKey) throw new Error("Pull request requires an idempotency key");
    try {
      const repo = await this.github.repositoryName();
      const existing = await this.github.api([`repos/${repo}/pulls`, "-f", `head=${repo.split("/")[0]}:${branch}`, "-f", `base=${base}`, "-f", "state=open"]);
      const pulls = JSON.parse(String(existing.stdout ?? "[]"));
      if (Array.isArray(pulls) && pulls.length) {
        const pr = pulls[0];
        if (pr.head?.sha && pr.head.sha.toLowerCase() !== sha.toLowerCase()) throw new RemoteAdapterError("pr_sha_mismatch", "Existing pull request head does not match the verified candidate SHA.");
        return { status: "open", number: pr.number, url: pr.html_url, state: pr.state, headSha: pr.head?.sha ?? sha, duplicate: true, idempotencyKey };
      }
      const created = await this.github.api([`repos/${repo}/pulls`, "--method", "POST", "-f", `title=${title ?? `Autonomous delivery: ${branch}`}`, "-f", `head=${branch}`, "-f", `base=${base}`, "-f", `body=${body ?? `Autonomous delivery candidate ${sha}.`}`]);
      const pr = JSON.parse(String(created.stdout ?? "{}"));
      if (!Number.isInteger(pr.number) || typeof pr.html_url !== "string") throw new RemoteAdapterError("pr_create_failed", "GitHub returned an invalid pull request response.");
      return { status: "open", number: pr.number, url: pr.html_url, state: pr.state ?? "open", headSha: pr.head?.sha ?? sha, duplicate: false, idempotencyKey };
    } catch (error) {
      if (error instanceof RemoteAdapterError) throw error;
      throw new RemoteAdapterError("pr_create_failed", `Pull request creation failed: ${compactError(error)}`, error);
    }
  }
}

export class RemoteCiAdapter {
  constructor({ check = null } = {}) { this.check = check; }
  async verify(candidate) {
    if (!this.check) return { status: "unavailable", reason: "No RemoteCiAdapter configured" };
    return this.check(candidate);
  }
  async waitForChecks(candidate) { return this.verify(candidate); }
}

export class GitHubCiAdapter {
  constructor({ repository, github = null, execute = exec, timeoutMs = 900000, pollIntervalMs = 10000 } = {}) {
    this.github = github ?? new GitHubAdapter({ repository, execute }); this.timeoutMs = timeoutMs; this.pollIntervalMs = pollIntervalMs;
  }

  async waitForChecks({ pullRequest, candidate }) {
    if (!pullRequest?.number) throw new RemoteAdapterError("ci_missing_pr", "Remote CI requires a persisted pull request number.");
    const deadline = Date.now() + this.timeoutMs;
    let last = null;
    while (Date.now() <= deadline) {
      try {
        const repo = await this.github.repositoryName();
        const checks = await this.github.api(["--method", "GET", `repos/${repo}/commits/${candidate.sha}/check-runs`]);
        const payload = JSON.parse(String(checks.stdout ?? "{}"));
        const runs = (payload.check_runs ?? []).map((run) => ({ name: run.name, status: run.status, conclusion: run.conclusion, detailsUrl: run.details_url }));
        last = { checkRuns: runs };
        if (runs.some((run) => run.status === "completed" && !["success", "neutral", "skipped"].includes(run.conclusion))) return { status: "failed", reason: "A remote CI check failed.", checkRuns: runs };
        if (runs.length && runs.every((run) => run.status === "completed" && ["success", "neutral", "skipped"].includes(run.conclusion))) return { status: "passed", checkRuns: runs };
        await sleep(this.pollIntervalMs);
      } catch (error) {
        if (error instanceof RemoteAdapterError) throw error;
        throw new RemoteAdapterError("ci_failed", `Remote CI lookup failed: ${compactError(error)}`, error);
      }
    }
    return { status: "timed_out", reason: "Timed out waiting for remote CI checks.", ...(last ?? {}) };
  }
}

export class PullRequestAdapter {
  constructor({ create = null } = {}) { this.create = create; }
  async handoff(candidate) {
    if (!this.create) return { status: "unavailable", reason: "No PullRequestAdapter configured" };
    return this.create(candidate);
  }
}

export class GitHubMergeAdapter {
  constructor({ repository, github = null, execute = exec, mergeMethod = "merge" } = {}) { this.github = github ?? new GitHubAdapter({ repository, execute }); this.repository = repository; this.execute = execute; this.mergeMethod = mergeMethod; }

  async merge({ pullRequest, candidate, base, idempotencyKey }) {
    if (!pullRequest?.number || !idempotencyKey) throw new Error("Merge requires a persisted pull request and idempotency key");
    if (!safeName(base) || protectedBranches.has(candidate.branch?.toLowerCase())) throw new Error("Unsafe merge target");
    try {
      const repo = await this.github.repositoryName();
      const response = await this.github.api([`repos/${repo}/pulls/${pullRequest.number}/merge`, "--method", "PUT", "-f", `merge_method=${this.mergeMethod}`, "-f", `sha=${candidate.sha}`, "-f", `commit_title=Autonomous delivery #${pullRequest.number}`]);
      const merged = JSON.parse(String(response.stdout ?? "{}"));
      if (!merged.merged) throw new RemoteAdapterError("branch_protection", merged.message ? `GitHub refused merge: ${merged.message}` : "GitHub refused the merge.");
      const main = await this.github.api([`repos/${repo}/git/ref/heads/${base}`]);
      const ref = JSON.parse(String(main.stdout ?? "{}"));
      const sha = ref.object?.sha;
      if (!/^[0-9a-f]{40}$/i.test(sha)) throw new RemoteAdapterError("merge_verify_failed", "Could not verify the target branch SHA after merge.");
      return { status: "merged", number: pullRequest.number, url: pullRequest.url, mergeSha: merged.sha ?? sha, mainSha: sha, idempotencyKey };
    } catch (error) {
      if (error instanceof RemoteAdapterError) throw error;
      if (isCredentialError(error)) throw new RemoteAdapterError("credentials", "GitHub CLI credentials are unavailable or invalid.", error);
      throw new RemoteAdapterError("merge_failed", `Pull request merge failed: ${compactError(error)}`, error);
    }
  }
}
