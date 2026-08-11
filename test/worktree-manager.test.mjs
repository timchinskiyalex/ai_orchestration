import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { WorktreeManager } from "../src/worktree-manager.mjs";

const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
function repository() {
  const root = mkdtempSync(join(tmpdir(), "worktree-manager-"));
  git(root, ["init", "-b", "main"]); writeFileSync(join(root, "README.md"), "base\n", "utf8"); git(root, ["add", "."]); git(root, ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "base"]);
  return root;
}

test("configured runtime inside repository is the only permitted runtime dirty prefix", async () => {
  const root = repository();
  try {
    const manager = new WorktreeManager({ repository: root, runtimeDir: join(root, "runtime"), baseRef: "main" });
    writeFileSync(join(root, "runtime", "swarm.sqlite"), "runtime", "utf8");
    await assert.doesNotReject(manager.verifyRepository());
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("untracked ProjectOverlay under the configured generated directory is allowed", async () => {
  const root = repository();
  try {
    const manager = new WorktreeManager({ repository: root, runtimeDir: join(root, "runtime"), baseRef: "main", project: { documentationDir: "docs/orchestration-input", generatedDir: "docs/orchestration-generated" } });
    mkdirSync(join(root, "docs", "orchestration-generated"), { recursive: true }); writeFileSync(join(root, "docs", "orchestration-generated", "project-overlay.v1.json"), "{}", "utf8");
    await assert.doesNotReject(manager.verifyRepository());
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("untracked docs note outside the generated allowlist is blocked", async () => {
  const root = repository();
  try {
    const manager = new WorktreeManager({ repository: root, runtimeDir: join(root, "runtime"), baseRef: "main", project: { documentationDir: "docs/orchestration-input", generatedDir: "docs/orchestration-generated" } });
    mkdirSync(join(root, "docs")); writeFileSync(join(root, "docs", "notes.md"), "unsafe", "utf8");
    await assert.rejects(manager.verifyRepository(), /docs\/notes\.md/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("allowed generated artifact does not mask an untracked source file", async () => {
  const root = repository();
  try {
    const manager = new WorktreeManager({ repository: root, runtimeDir: join(root, "runtime"), baseRef: "main", project: { documentationDir: "docs/orchestration-input", generatedDir: "docs/orchestration-generated" } });
    mkdirSync(join(root, "docs", "orchestration-generated"), { recursive: true }); writeFileSync(join(root, "docs", "orchestration-generated", "project-overlay.v1.json"), "{}", "utf8");
    mkdirSync(join(root, "src")); writeFileSync(join(root, "src", "unsafe.mjs"), "export {};", "utf8");
    await assert.rejects(manager.verifyRepository(), /src\/unsafe\.mjs/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("NUL porcelain parsing preserves paths with spaces and Unicode", async () => {
  const root = repository();
  try {
    const manager = new WorktreeManager({ repository: root, runtimeDir: join(root, "runtime"), baseRef: "main", project: { documentationDir: "docs/orchestration-input", generatedDir: "docs/orchestration-generated" } });
    mkdirSync(join(root, "docs", "orchestration-generated"), { recursive: true }); writeFileSync(join(root, "docs", "orchestration-generated", "план with spaces.json"), "{}", "utf8");
    await assert.doesNotReject(manager.verifyRepository());
    mkdirSync(join(root, "src")); writeFileSync(join(root, "src", "небезпечний file.mjs"), "export {};", "utf8");
    await assert.rejects(manager.verifyRepository(), /src\/небезпечний file\.mjs/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("uncommitted source remains blocked when configured runtime is present", async () => {
  const root = repository();
  try {
    const manager = new WorktreeManager({ repository: root, runtimeDir: join(root, "runtime"), baseRef: "main" });
    writeFileSync(join(root, "runtime", "swarm.sqlite"), "runtime", "utf8"); mkdirSync(join(root, "src")); writeFileSync(join(root, "src", "unsafe.mjs"), "export {};\n", "utf8");
    await assert.rejects(manager.verifyRepository(), /src\//);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("runtime outside repository does not permit an unrelated in-repository runtime directory", async () => {
  const root = repository(); const external = mkdtempSync(join(tmpdir(), "external-runtime-"));
  try {
    const manager = new WorktreeManager({ repository: root, runtimeDir: external, baseRef: "main" });
    mkdirSync(join(root, "runtime")); writeFileSync(join(root, "runtime", "swarm.sqlite"), "not-owned", "utf8");
    await assert.rejects(manager.verifyRepository(), /runtime\//);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(external, { recursive: true, force: true }); }
});
