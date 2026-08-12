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
  constructor({ repository, github = null, execute = exec, timeoutMs = 900000, pollIntervalMs = 10000, requiredContexts = [] } = {}) {
    this.github = github ?? new GitHubAdapter({ repository, execute }); this.timeoutMs = timeoutMs; this.pollIntervalMs = pollIntervalMs; this.requiredContexts = requiredContexts;
  }

  async #requiredContexts(repo, base) {
    if (this.requiredContexts.length) return { contexts: this.requiredContexts, source: "config" };
    try {
      const protection = await this.github.api(["--method", "GET", `repos/${repo}/branches/${base}/protection`]);
      const payload = JSON.parse(String(protection.stdout ?? "{}"));
      const contexts = payload.required_status_checks?.checks?.map((item) => item.context) ?? payload.required_status_checks?.contexts ?? [];
      const unique = [...new Set(contexts.filter((item) => typeof item === "string" && item.trim()))];
      if (!unique.length) throw new RemoteAdapterError("ci_policy_missing", "Target branch protection has no required status-check contexts; configure remote.requiredCiContexts explicitly.");
      return { contexts: unique, source: "branch_protection" };
    } catch (error) {
      if (error instanceof RemoteAdapterError) throw error;
      throw new RemoteAdapterError("ci_policy_missing", "Required CI policy is unavailable; configure remote.requiredCiContexts or grant read access to target branch protection.", error);
    }
  }

  async waitForChecks({ pullRequest, candidate }) {
    if (!pullRequest?.number) throw new RemoteAdapterError("ci_missing_pr", "Remote CI requires a persisted pull request number.");
    if (!/^[0-9a-f]{40}$/i.test(candidate?.sha ?? "")) throw new RemoteAdapterError("ci_invalid_candidate", "Remote CI requires the exact 40-character candidate SHA.");
    const deadline = Date.now() + this.timeoutMs;
    let last = null;
    while (Date.now() <= deadline) {
      try {
        const repo = await this.github.repositoryName();
        const policy = await this.#requiredContexts(repo, candidate.base);
        const [checks, statuses] = await Promise.all([this.github.api(["--method", "GET", `repos/${repo}/commits/${candidate.sha}/check-runs?per_page=100`]), this.github.api(["--method", "GET", `repos/${repo}/commits/${candidate.sha}/status`])]);
        const checkPayload = JSON.parse(String(checks.stdout ?? "{}")); const statusPayload = JSON.parse(String(statuses.stdout ?? "{}"));
        const runs = (checkPayload.check_runs ?? []).map((run) => ({ name: run.name, status: run.status, conclusion: run.conclusion, headSha: run.head_sha ?? null, detailsUrl: run.details_url }));
        const statusChecks = (statusPayload.statuses ?? []).map((status) => ({ name: status.context, status: status.state, conclusion: status.state, sha: statusPayload.sha ?? status.sha ?? null, detailsUrl: status.target_url ?? null }));
        const required = policy.contexts.map((name) => {
          const matchingRuns = runs.filter((run) => run.name === name && (!run.headSha || run.headSha.toLowerCase() === candidate.sha.toLowerCase()));
          const matchingStatuses = statusChecks.filter((status) => status.name === name && (!status.sha || status.sha.toLowerCase() === candidate.sha.toLowerCase()));
          const matches = [...matchingRuns, ...matchingStatuses];
          if (!matches.length) return { name, state: "missing" };
          if (matches.some((item) => (item.status === "completed" && !["success", "neutral", "skipped"].includes(item.conclusion)) || ["failure", "error"].includes(item.status))) return { name, state: "failed", matches };
          if (matches.some((item) => item.status !== "completed" && item.status !== "success" && item.status !== "neutral" && item.status !== "skipped")) return { name, state: "pending", matches };
          return { name, state: "passed", matches };
        });
        last = { checkRuns: runs, statusChecks, requiredContexts: policy.contexts, required, policySource: policy.source };
        if (required.some((item) => item.state === "failed")) return { status: "failed", reason: "A required remote CI context failed for the candidate SHA.", ...last };
        if (required.every((item) => item.state === "passed")) return { status: "passed", ...last };
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
      const verifyHead = (pr) => {
        if (pr.head?.sha?.toLowerCase() !== candidate.sha.toLowerCase() || pr.base?.ref !== base) throw new RemoteAdapterError("merge_verify_failed", "Persisted pull request no longer points at the candidate SHA and target branch.");
      };
      const verifyTarget = async (pr) => {
        verifyHead(pr);
        const [main, comparison] = await Promise.all([this.github.api([`repos/${repo}/git/ref/heads/${base}`]), this.github.api([`repos/${repo}/compare/${candidate.sha}...${base}`])]);
        const ref = JSON.parse(String(main.stdout ?? "{}")); const compare = JSON.parse(String(comparison.stdout ?? "{}")); const sha = ref.object?.sha;
        if (!/^[0-9a-f]{40}$/i.test(sha) || !["behind", "identical"].includes(compare.status)) throw new RemoteAdapterError("merge_verify_failed", "Target branch was not verified to contain the candidate after merge.");
        return sha;
      };
      const current = JSON.parse(String((await this.github.api([`repos/${repo}/pulls/${pullRequest.number}`])).stdout ?? "{}"));
      if (current.merged_at) { const mainSha = await verifyTarget(current); return { status: "merged", number: pullRequest.number, url: current.html_url ?? pullRequest.url, mergeSha: current.merge_commit_sha ?? mainSha, mainSha, targetVerified: true, duplicate: true, idempotencyKey }; }
      verifyHead(current);
      const response = await this.github.api([`repos/${repo}/pulls/${pullRequest.number}/merge`, "--method", "PUT", "-f", `merge_method=${this.mergeMethod}`, "-f", `sha=${candidate.sha}`, "-f", `commit_title=Autonomous delivery #${pullRequest.number}`]);
      const merged = JSON.parse(String(response.stdout ?? "{}"));
      if (!merged.merged) throw new RemoteAdapterError("branch_protection", merged.message ? `GitHub refused merge: ${merged.message}` : "GitHub refused the merge.");
      const verifiedPr = JSON.parse(String((await this.github.api([`repos/${repo}/pulls/${pullRequest.number}`])).stdout ?? "{}"));
      if (!verifiedPr.merged_at) throw new RemoteAdapterError("merge_verify_failed", "GitHub merge endpoint responded but the pull request is not marked merged.");
      const sha = await verifyTarget(verifiedPr);
      return { status: "merged", number: pullRequest.number, url: pullRequest.url, mergeSha: merged.sha ?? sha, mainSha: sha, targetVerified: true, idempotencyKey };
    } catch (error) {
      if (error instanceof RemoteAdapterError) throw error;
      if (isCredentialError(error)) throw new RemoteAdapterError("credentials", "GitHub CLI credentials are unavailable or invalid.", error);
      throw new RemoteAdapterError("merge_failed", `Pull request merge failed: ${compactError(error)}`, error);
    }
  }
}
