import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const copiedEntries = [".gitignore", "package.json", "config", "docs", "policies", "roles", "scripts", "src", "test"];

function assertTargetIsSafe(target) {
  if (!existsSync(target)) { mkdirSync(target, { recursive: true }); return; }
  const disallowed = readdirSync(target).filter((entry) => ![".git", "README.md"].includes(entry));
  if (disallowed.length) throw new Error(`Target is not an empty instance repository: ${disallowed.join(", ")}`);
}

function copyEntry(from, to) {
  const stat = lstatSync(from);
  if (stat.isSymbolicLink()) throw new Error(`Template symlink is not supported: ${from}`);
  if (stat.isDirectory()) {
    mkdirSync(to, { recursive: true });
    for (const entry of readdirSync(from)) copyEntry(join(from, entry), join(to, entry));
    return;
  }
  copyFileSync(from, to);
}

export function scaffoldInstance({ templateRoot, target, projectName }) {
  const source = resolve(templateRoot);
  const destination = resolve(target);
  if (!projectName?.trim()) throw new Error("projectName is required");
  if (!existsSync(join(source, "package.json"))) throw new Error(`Not an orchestration template: ${source}`);
  assertTargetIsSafe(destination);
  for (const entry of copiedEntries) {
    const from = join(source, entry);
    const to = join(destination, entry);
    if (!existsSync(from)) throw new Error(`Template is missing ${entry}`);
    copyEntry(from, to);
  }
  const packageInfo = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
  writeFileSync(join(destination, "README.md"), `# ${projectName}\n\nThis repository was created from ${packageInfo.name}@${packageInfo.version}.\n\nSee docs/ARCHITECTURE.md and config/swarm.config.example.json.\n`, "utf8");
  writeFileSync(join(destination, ".orchestration-template.json"), `${JSON.stringify({ template: packageInfo.name, version: packageInfo.version, createdAt: new Date().toISOString(), projectName, templateDirectory: basename(source) }, null, 2)}\n`, "utf8");
  return { target: destination, projectName: projectName.trim() };
}
