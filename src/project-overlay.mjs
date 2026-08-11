import { existsSync, lstatSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const OVERLAY_VERSION = 1;
const sensitiveName = /(^|\/)(\.env(?:\.|$)|[^/]*\.(?:pem|key)$|[^/]*(?:credentials|secrets)[^/]*)/i;
const ignored = new Set([".git", "node_modules", "dist", "build", "coverage", ".next"]);
const toPosix = (value) => value.split(sep).join("/");
const packageManagers = new Map([["npm", "package-lock.json"], ["pnpm", "pnpm-lock.yaml"], ["yarn", "yarn.lock"]]);

export const STACK_ADAPTERS = Object.freeze({
  node: { productionReady: true, packageManagers: ["npm", "pnpm", "yarn"] },
  python: { productionReady: false, reason: "a Python adapter is required before verification can run" },
  go: { productionReady: false, reason: "a Go adapter is required before verification can run" },
  dotnet: { productionReady: false, reason: ".NET adapter is required before verification can run" }
});

async function git(repository, args) { return (await exec("git", ["-C", repository, ...args])).stdout.trim(); }
function safeRead(path) { return readFileSync(path, "utf8"); }
function walk(root, max = 2000) {
  const found = [];
  const visit = (directory) => {
    if (found.length >= max) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (ignored.has(entry.name)) continue;
      const absolute = join(directory, entry.name);
      const path = toPosix(relative(root, absolute));
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) found.push(path);
      if (found.length >= max) return;
    }
  };
  visit(root);
  return found;
}
function evidence(ledger, path, selector, parser, value, confidence = "verified") {
  ledger.push({ path, selector, parser, value, confidence });
}
function lineOf(text, needle) { const index = text.indexOf(needle); return index < 0 ? "unknown" : String(text.slice(0, index).split("\n").length); }
function agents(files) {
  return files.filter((path) => /(^|\/)(AGENTS(?:\.override)?\.md)$/i.test(path)).map((path) => ({ path, scope: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".", confidence: "verified" }));
}
function workflowMetadata(repository, files, ledger) {
  return files.filter((path) => /^\.github\/workflows\/.*\.(?:yml|yaml)$/i.test(path)).map((path) => {
    const text = safeRead(join(repository, path));
    const jobs = [...text.matchAll(/^\s{2}([A-Za-z0-9_-]+):\s*$/gm)].map((m) => m[1]);
    const commands = [...text.matchAll(/^\s*run:\s*(.+)$/gm)].map((m) => m[1].trim());
    const permissions = [...text.matchAll(/^\s*permissions:\s*(.+)?$/gm)].map((m) => (m[1] ?? "block").trim());
    const environments = [...text.matchAll(/^\s*environment:\s*(.+)$/gm)].map((m) => m[1].trim());
    evidence(ledger, path, "workflow lines", "yaml-line-scanner", { jobs, commands }, "declared");
    return { path, jobs, commands, permissions, environments, requiredChecks: "unknown", confidence: "declared" };
  });
}

function detectPackageManager(packageJson, lockfiles, ledger, packagePath) {
  const declared = typeof packageJson.packageManager === "string" ? packageJson.packageManager.split("@")[0] : null;
  const fromLock = [...packageManagers.entries()].find(([, file]) => lockfiles.includes(file))?.[0] ?? null;
  const name = declared ?? fromLock;
  if (!name || !packageManagers.has(name)) throw new Error(`Unsupported Node package manager '${declared ?? "unknown"}'. Declare packageManager as npm, pnpm, or yarn, or commit its supported lockfile.`);
  const source = declared ? "package.json#packageManager" : "lockfile";
  evidence(ledger, declared ? packagePath : packageManagers.get(name), declared ? "packageManager" : "path", declared ? "json" : "file-name", name, declared ? "declared" : "verified");
  return { name, version: declared ? packageJson.packageManager.slice(name.length + 1) || null : null, source, confidence: declared ? "declared" : "verified" };
}

function packageCommand(manager, script) {
  const rendered = `${manager} run ${script}`;
  return process.platform === "win32"
    ? { executable: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", rendered] }
    : { executable: manager, args: ["run", script] };
}

export async function generateProjectOverlay({ repository, baseRef = "HEAD", generatedDir = "docs/orchestration-generated" }) {
  const root = await git(repository, ["rev-parse", "--show-toplevel"]);
  const [baseSha, branch, status] = await Promise.all([
    git(root, ["rev-parse", baseRef]), git(root, ["branch", "--show-current"]), git(root, ["status", "--porcelain"])
  ]);
  const files = walk(root);
  const ledger = [];
  evidence(ledger, ".git", "rev-parse --show-toplevel", "git", root, "verified");
  evidence(ledger, ".git", `rev-parse ${baseRef}`, "git", baseSha, "verified");
  evidence(ledger, ".git", "branch --show-current / status --porcelain", "git", { branch: branch || "detached", clean: !status }, "verified");
  const packagePath = files.find((path) => path === "package.json");
  let packageJson = null;
  if (packagePath) {
    const text = safeRead(join(root, packagePath));
    packageJson = JSON.parse(text);
    evidence(ledger, packagePath, "package.json", "json", { name: packageJson.name ?? null, scripts: Object.keys(packageJson.scripts ?? {}) }, "verified");
  }
  const lockfiles = files.filter((path) => /(?:^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml)$/i.test(path));
  const tsconfigs = files.filter((path) => /(^|\/)tsconfig(?:\.[^/]+)?\.json$/i.test(path));
  for (const path of [...lockfiles, ...tsconfigs]) evidence(ledger, path, "path", "file-name", true, "verified");
  if (!packageJson) {
    const detected = files.find((path) => /(^|\/)(pyproject\.toml|requirements\.txt|go\.mod|.+\.csproj)$/i.test(path));
    throw new Error(detected ? `Unsupported repository stack detected at ${detected}; ${STACK_ADAPTERS.python.reason} / ${STACK_ADAPTERS.go.reason} / ${STACK_ADAPTERS.dotnet.reason}` : "Unsupported repository stack: no package.json. Add a stack adapter before orchestration.");
  }
  const packageManager = detectPackageManager(packageJson, lockfiles, ledger, packagePath);
  const scriptEntries = Object.entries(packageJson.scripts ?? {}).map(([name, command]) => ({ name, command, confidence: "declared", source: packagePath }));
  for (const script of scriptEntries) evidence(ledger, packagePath, `scripts.${script.name}`, "json", script.command, "declared");
  const verificationCommands = scriptEntries.filter((item) => /^(test|test:unit|test:integration|test:e2e|lint|format:check|typecheck|build)$/.test(item.name)).map((item) => ({
    id: `package-script:${item.name}`,
    ...packageCommand(packageManager.name, item.name), source: packagePath, confidence: "declared"
  }));
  const modules = Object.fromEntries(Object.entries({
    backend: /(^|\/)(server|api|backend|routes|controllers)(\/|$)/i,
    frontend: /(^|\/)(src\/)?(?:components|pages|app|frontend)(\/|$)/i,
    database: /(^|\/)(migrations?|schema|database|db)(\/|$)/i,
    infrastructure: /(^|\/)(infra|terraform|k8s|helm|docker|\.github)(\/|$)/i
  }).map(([name, pattern]) => {
    const paths = files.filter((path) => pattern.test(path));
    if (paths.length) evidence(ledger, paths[0], "path", "area-name-pattern", name, "inferred");
    return [name, { present: paths.length > 0, paths: paths.slice(0, 25), confidence: paths.length ? "inferred" : "unknown" }];
  }));
  const sensitivePaths = files.filter((path) => sensitiveName.test(path)).map((path) => ({ path, classification: "sensitive-name", contentRead: false, confidence: "verified" }));
  for (const item of sensitivePaths) evidence(ledger, item.path, "path", "name-pattern", "sensitive-name", "verified");
  const pathPolicies = {
    denyWrite: sensitivePaths.map((item) => item.path),
    approvalRequired: files.filter((p) => /(^\.github\/workflows\/|(^|\/)(migrations?|infra|terraform|k8s|helm)\/)/i.test(p)),
    generatedDoNotEdit: [],
    contextExclude: sensitivePaths.map((item) => item.path)
  };
  for (const [kind, paths] of Object.entries(pathPolicies)) for (const path of paths) evidence(ledger, path, "path", "policy-pattern", kind, kind === "approvalRequired" ? "inferred" : "verified");
  const agentInstructions = agents(files);
  for (const agent of agentInstructions) evidence(ledger, agent.path, `scope ${agent.scope}`, "path", "AGENTS instruction", "verified");
  const overlay = {
    schemaVersion: OVERLAY_VERSION, generatedAt: new Date().toISOString(),
    repository: { gitRoot: root, baseSha, branch: branch || "detached", clean: !status, dirtyPaths: status ? status.split(/\r?\n/).map((line) => line.slice(3)) : [] },
    stack: { adapter: "node", adapterSupport: "production-ready", node: true, packageManager, typescript: tsconfigs.length > 0, packageJson, lockfiles, tsconfigs, workspaces: packageJson.workspaces ?? [] },
    scripts: scriptEntries, verificationCommands, workflows: workflowMetadata(root, files, ledger),
    agents: agentInstructions, modules, pathPolicies, sensitivePaths, evidenceLedger: ledger
  };
  const destination = join(root, generatedDir, "project-overlay.v1.json");
  mkdirSync(resolve(destination, ".."), { recursive: true });
  writeFileSync(destination, JSON.stringify(overlay, null, 2) + "\n", "utf8");
  return { overlay, path: toPosix(relative(root, destination)) };
}

export function loadProjectOverlay(repository, generatedDir = "docs/orchestration-generated") {
  const path = join(repository, generatedDir, "project-overlay.v1.json");
  if (!existsSync(path)) throw new Error(`Missing ProjectOverlay: ${path}`);
  const overlay = JSON.parse(safeRead(path));
  if (overlay.schemaVersion !== OVERLAY_VERSION) throw new Error(`Unsupported ProjectOverlay schema version: ${overlay.schemaVersion}`);
  return { overlay, path: toPosix(relative(repository, path)) };
}

// This is deliberately a lossy view of the controller-owned Overlay.  It is
// safe to put in a worker prompt and must never become a substitute for the
// full evidence ledger or path-policy enforcement in the controller.
export function projectOverlayExecutionSnapshot(overlay) {
  if (!overlay || overlay.schemaVersion !== OVERLAY_VERSION) {
    throw new Error("Cannot create execution snapshot from an unsupported ProjectOverlay");
  }
  const sensitive = new Set((overlay.sensitivePaths ?? []).map((item) => item.path));
  const isSensitive = (path) => sensitive.has(path) || [...sensitive].some((entry) => entry.startsWith(`${path}/`) || path.startsWith(`${entry}/`));
  const safePolicyPaths = (paths) => (paths ?? []).filter((path) => !isSensitive(path));
  const confidenceCounts = {};
  const parsers = new Set();
  for (const item of overlay.evidenceLedger ?? []) {
    confidenceCounts[item.confidence] = (confidenceCounts[item.confidence] ?? 0) + 1;
    if (item.parser) parsers.add(item.parser);
  }
  return {
    schemaVersion: 1,
    sourceOverlayVersion: overlay.schemaVersion,
    baseSha: overlay.repository?.baseSha ?? null,
    stack: {
      adapter: overlay.stack?.adapter ?? null,
      adapterSupport: overlay.stack?.adapterSupport ?? null,
      node: Boolean(overlay.stack?.node),
      typescript: Boolean(overlay.stack?.typescript),
      packageManager: overlay.stack?.packageManager ? {
        name: overlay.stack.packageManager.name ?? null,
        version: overlay.stack.packageManager.version ?? null,
        source: overlay.stack.packageManager.source ?? null,
        confidence: overlay.stack.packageManager.confidence ?? "unknown"
      } : null
    },
    verificationCommands: (overlay.verificationCommands ?? []).map((command) => ({
      id: command.id, executable: command.executable, args: command.args, confidence: command.confidence
    })),
    modules: Object.fromEntries(Object.entries(overlay.modules ?? {}).map(([name, value]) => [name, {
      present: Boolean(value?.present), confidence: value?.confidence ?? "unknown"
    }])),
    agents: (overlay.agents ?? []).map((agent) => ({ path: agent.path, scope: agent.scope, confidence: agent.confidence })),
    pathPolicies: {
      approvalRequired: safePolicyPaths(overlay.pathPolicies?.approvalRequired),
      generatedDoNotEdit: safePolicyPaths(overlay.pathPolicies?.generatedDoNotEdit)
    },
    evidenceSummary: { entries: (overlay.evidenceLedger ?? []).length, confidenceCounts, parsers: [...parsers].sort() }
  };
}
