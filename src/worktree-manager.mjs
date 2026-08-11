import { existsSync, mkdirSync } from "node:fs";
import { resolve, relative, sep, isAbsolute } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const safePart = (value) => value.replace(/[^a-zA-Z0-9._-]/g, "-");
const toPosix = (value) => value.replace(/\\/g, "/");

function containedPrefix(repository, candidate) {
  const relation = relative(repository, candidate);
  if (!relation || relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) return null;
  return `${toPosix(relation).replace(/\/$/, "")}/`;
}

function porcelainPaths(output) {
  const fields = output.split("\0");
  const paths = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (!field) continue;
    if (field.length < 4 || field[2] !== " ") throw new Error("Unexpected Git porcelain v1 -z record");
    const status = field.slice(0, 2);
    paths.push(field.slice(3));
    if (status.includes("R") || status.includes("C")) {
      const original = fields[++index];
      if (original === undefined) throw new Error("Truncated Git porcelain rename/copy record");
      paths.push(original);
    }
  }
  return paths.map(toPosix);
}

export class WorktreeManager {
  constructor({ repository, runtimeDir, baseRef, project = {} }) {
    this.repository = resolve(repository);
    this.runtimeDir = resolve(runtimeDir);
    this.root = resolve(runtimeDir, "worktrees");
    this.baseRef = baseRef;
    this.runtimeDirtyPrefix = containedPrefix(this.repository, this.runtimeDir);
    this.allowedDirtyPrefixes = [project.documentationDir, project.generatedDir].filter(Boolean).map((value) => value.replace(/\\/g, "/").replace(/\/$/, "") + "/");
    if (this.runtimeDirtyPrefix) this.allowedDirtyPrefixes.push(this.runtimeDirtyPrefix);
    mkdirSync(this.root, { recursive: true });
  }

  async verifyRepository() {
    const { stdout } = await exec("git", ["-C", this.repository, "rev-parse", "--is-inside-work-tree"]);
    if (stdout.trim() !== "true") throw new Error(`${this.repository} is not a Git worktree`);
    const status = await exec("git", ["-C", this.repository, "status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    const dirtyPaths = porcelainPaths(status.stdout);
    const unsafePaths = dirtyPaths.filter((path) => !this.allowedDirtyPrefixes.some((prefix) => path.startsWith(prefix)));
    if (unsafePaths.length) throw new Error(`Target repository has uncommitted code changes; refuse to create swarm worktrees: ${unsafePaths.join(", ")}`);
  }

  async create(taskId, { baseSha = this.baseRef } = {}) {
    const name = safePart(taskId);
    const worktree = resolve(this.root, name);
    const branch = `swarm/${name}`;
    if (existsSync(worktree)) throw new Error(`Worktree already exists: ${worktree}`);
    if (typeof baseSha !== "string" || !/^[A-Za-z0-9._/-]+$/.test(baseSha)) throw new Error("Worktree base must be a Git ref or SHA");
    await exec("git", ["-C", this.repository, "worktree", "add", "-b", branch, worktree, baseSha]);
    return { worktree, branch };
  }

  async remove(worktree) {
    const target = resolve(worktree);
    const relation = relative(this.root, target);
    if (!relation || relation.startsWith(`..${sep}`) || relation === "..") throw new Error(`Refuse to remove worktree outside runtime root: ${target}`);
    await exec("git", ["-C", this.repository, "worktree", "remove", "--force", target]);
  }

  async recovery(worktree) {
    const target = resolve(worktree);
    const relation = relative(this.root, target);
    if (!relation || relation.startsWith(`..${sep}`) || relation === "..") throw new Error(`Refuse recovery outside runtime root: ${target}`);
    const { stdout } = await exec("git", ["-C", target, "status", "--porcelain"]);
    return { worktree: target, clean: !stdout.trim(), action: "Inspect or preserve this isolated worktree; remove it explicitly only after recovery is complete." };
  }
}
