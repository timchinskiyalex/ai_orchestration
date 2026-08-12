import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { relative } from "node:path";
import { normalizeWriteSurface, writeSurfacesOverlap } from "./write-surface.mjs";

export const REPOSITORY_BASELINE_SCHEMA_VERSION = 1;
export const REPOSITORY_BASELINE_KIND = "RepositoryBaseline";
const sha = (value) => typeof value === "string" && /^[a-f0-9]{40,64}$/i.test(value);
const safeId = (value) => typeof value === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(value);
const safeCommandId = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/.test(value);
const safeLabel = (value) => typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 120 && !/[\r\n\0]/.test(value);
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
export const repositoryBaselineDigest = (value) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");

function fail(code) { throw new Error(`repository_baseline:${code}`); }
function git(repository, args, encoding = "utf8") { return execFileSync("git", ["-C", repository, ...args], { encoding }); }
function treeAt(repository, baseSha) {
  const output = git(repository, ["ls-tree", "-r", "-z", baseSha], "buffer");
  const entries = output.toString("utf8").split("\0").filter(Boolean).map((line) => {
    const match = line.match(/^(\d+) ([^ ]+) ([0-9a-f]{40,64})\t(.+)$/i);
    if (!match) fail("tracked_tree_malformed");
    return { mode: match[1], type: match[2], objectId: match[3].toLowerCase(), path: normalizeWriteSurface(match[4]) };
  }).sort((a, b) => a.path.localeCompare(b.path));
  if (new Set(entries.map((entry) => entry.path)).size !== entries.length) fail("tracked_tree_duplicate_path");
  return entries;
}
function commandIds(overlay) {
  const ids = (overlay?.verificationCommands ?? []).map((command) => command?.id);
  if (!ids.length || ids.some((id) => typeof id !== "string" || !id) || new Set(ids).size !== ids.length) fail("overlay_command_ids_invalid");
  return ids.sort();
}
export function parseRepositoryBaselineDeclaration(path) {
  let value;
  try { value = JSON.parse(readFileSync(path, "utf8")); } catch { fail("declaration_unavailable"); }
  if (!value || value.schemaVersion !== 1 || value.kind !== "RepositoryBaselineDeclaration" || !Array.isArray(value.behaviors) || !Array.isArray(value.impactEdges)) fail("declaration_malformed");
  const ids = new Set();
  const behaviors = value.behaviors.map((behavior) => {
    if (!behavior || !safeId(behavior.behaviorId) || ids.has(behavior.behaviorId) || !safeLabel(behavior.category) || !safeLabel(behavior.label) || !safeCommandId(behavior.verificationCommandId) || !Array.isArray(behavior.protectedSurfaces) || !behavior.protectedSurfaces.length) fail("declaration_behavior_invalid");
    ids.add(behavior.behaviorId);
    const protectedSurfaces = [...new Set(behavior.protectedSurfaces.map(normalizeWriteSurface))].sort();
    const selectedTrackedPaths = behavior.selectedTrackedPaths === undefined ? [] : [...new Set((Array.isArray(behavior.selectedTrackedPaths) ? behavior.selectedTrackedPaths : fail("declaration_selected_paths_invalid")).map(normalizeWriteSurface))].sort();
    return { behaviorId: behavior.behaviorId, category: behavior.category, label: behavior.label, protectedSurfaces, verificationCommandId: behavior.verificationCommandId, selectedTrackedPaths };
  }).sort((a, b) => a.behaviorId.localeCompare(b.behaviorId));
  const behaviorById = new Map(behaviors.map((behavior) => [behavior.behaviorId, behavior]));
  const seenEdges = new Set();
  const impactEdges = value.impactEdges.map((edge) => {
    if (!edge || !safeId(edge.behaviorId) || !behaviorById.has(edge.behaviorId)) fail("declaration_impact_unknown_behavior");
    const protectedSurface = normalizeWriteSurface(edge.protectedSurface);
    if (!behaviorById.get(edge.behaviorId).protectedSurfaces.includes(protectedSurface)) fail("declaration_impact_surface_not_declared");
    const identity = `${protectedSurface}:${edge.behaviorId}`;
    if (seenEdges.has(identity)) fail("declaration_impact_duplicate");
    seenEdges.add(identity); return { protectedSurface, behaviorId: edge.behaviorId };
  }).sort((a, b) => `${a.protectedSurface}:${a.behaviorId}`.localeCompare(`${b.protectedSurface}:${b.behaviorId}`));
  if (!impactEdges.length || behaviors.some((behavior) => !impactEdges.some((edge) => edge.behaviorId === behavior.behaviorId))) fail("declaration_impact_missing");
  return { schemaVersion: 1, kind: "RepositoryBaselineDeclaration", behaviors, impactEdges };
}

export function captureRepositoryBaselineDraft({ repository, baseRef, declarationPath, overlay }) {
  const baseSha = git(repository, ["rev-parse", "--verify", `${baseRef}^{commit}`]).trim().toLowerCase();
  if (!sha(baseSha)) fail("base_sha_invalid");
  if (overlay?.repository?.baseSha?.toLowerCase() !== baseSha) fail("overlay_base_mismatch");
  const declaration = parseRepositoryBaselineDeclaration(declarationPath);
  const commands = commandIds(overlay); const tree = treeAt(repository, baseSha); const byPath = new Map(tree.map((entry) => [entry.path, entry]));
  let declarationRelative;
  try { declarationRelative = normalizeWriteSurface(relative(repository, declarationPath)); } catch { fail("declaration_path_invalid"); }
  if (!byPath.has(declarationRelative)) fail("declaration_untracked");
  try {
    const atBase = git(repository, ["show", `${baseSha}:${declarationRelative}`], "buffer");
    if (!Buffer.from(atBase).equals(readFileSync(declarationPath))) fail("declaration_not_at_base");
  } catch (error) { if (String(error?.message).includes("repository_baseline:")) throw error; fail("declaration_not_at_base"); }
  for (const behavior of declaration.behaviors) {
    if (!commands.includes(behavior.verificationCommandId)) fail("declaration_command_unknown");
    for (const path of behavior.selectedTrackedPaths) if (!byPath.has(path)) fail("declaration_selected_path_untracked");
  }
  const selectedTrackedPaths = declaration.behaviors.flatMap((behavior) => behavior.selectedTrackedPaths.map((path) => ({ behaviorId: behavior.behaviorId, ...byPath.get(path) }))).sort((a, b) => `${a.behaviorId}:${a.path}`.localeCompare(`${b.behaviorId}:${b.path}`));
  const declarationDigest = repositoryBaselineDigest(declaration);
  const trackedTreeDigest = repositoryBaselineDigest(tree);
  return canonical({ schemaVersion: REPOSITORY_BASELINE_SCHEMA_VERSION, kind: "RepositoryBaselineDraft", baseRef, baseSha, declarationPath: declarationRelative, declarationDigest, trackedTreeDigest, trackedTreeCount: tree.length, selectedTrackedPaths, overlayCommandIds: commands, overlayCommandIdsDigest: repositoryBaselineDigest(commands), behaviors: declaration.behaviors, impactEdges: declaration.impactEdges });
}

export function finalizeRepositoryBaseline({ draft, blueprintId, blueprintDigest }) {
  if (!draft || draft.kind !== "RepositoryBaselineDraft" || !safeId(blueprintId) || !/^[a-f0-9]{64}$/i.test(blueprintDigest)) fail("finalization_invalid");
  const body = canonical({ ...draft, kind: REPOSITORY_BASELINE_KIND, baselineId: `rb-${repositoryBaselineDigest({ ...draft, blueprintId, blueprintDigest }).slice(0, 32)}`, productBlueprintId: blueprintId, productBlueprintDigest: blueprintDigest });
  return canonical({ ...body, digest: repositoryBaselineDigest(body) });
}

export function assertRepositoryBaselineCurrent({ repository, baseRef, declarationPath, overlay, baseline, blueprintId = null, blueprintDigest = null }) {
  if (!baseline || baseline.kind !== REPOSITORY_BASELINE_KIND || !sha(baseline.baseSha) || !/^[a-f0-9]{64}$/i.test(baseline.digest)) fail("baseline_malformed");
  const current = captureRepositoryBaselineDraft({ repository, baseRef, declarationPath, overlay });
  const expected = { ...baseline, kind: "RepositoryBaselineDraft" };
  for (const key of ["baselineId", "productBlueprintId", "productBlueprintDigest", "digest"]) delete expected[key];
  if (JSON.stringify(canonical(expected)) !== JSON.stringify(current)) fail("baseline_stale");
  const body = { ...baseline }; delete body.digest;
  if (repositoryBaselineDigest(body) !== baseline.digest) fail("baseline_digest_mismatch");
  if (blueprintId && (baseline.productBlueprintId !== blueprintId || baseline.productBlueprintDigest !== blueprintDigest)) fail("baseline_blueprint_mismatch");
  return baseline;
}

export function requiredBaselineBehaviorIds(allowedPaths, baseline) {
  if (!baseline || baseline.kind !== REPOSITORY_BASELINE_KIND) fail("baseline_invalid");
  return [...new Set(baseline.impactEdges.filter((edge) => allowedPaths.some((path) => writeSurfacesOverlap([path], [edge.protectedSurface]))).map((edge) => edge.behaviorId))].sort();
}

export function validateTaskBaselineBehaviorIds(task, baseline) {
  if (baseline.declarationPath && task.allowedPaths.some((path) => writeSurfacesOverlap([path], [baseline.declarationPath]))) fail("task_declaration_write_forbidden");
  const required = requiredBaselineBehaviorIds(task.allowedPaths, baseline);
  const actual = task.baselineBehaviorIds === undefined ? [] : task.baselineBehaviorIds;
  if (!Array.isArray(actual) || actual.some((id) => !safeId(id)) || new Set(actual).size !== actual.length) fail("task_behavior_ids_invalid");
  const known = new Set(baseline.behaviors.map((behavior) => behavior.behaviorId));
  if (actual.some((id) => !known.has(id))) fail("task_behavior_unknown");
  if (actual.some((id) => !required.includes(id)) || actual.length !== required.length || required.some((id) => !actual.includes(id))) fail("task_behavior_scope_mismatch");
  return required;
}

export function repositoryBaselineStatus(baseline) {
  return baseline ? { baselineId: baseline.baselineId, digest: baseline.digest, baseSha: baseline.baseSha, productBlueprintId: baseline.productBlueprintId, productBlueprintDigest: baseline.productBlueprintDigest, trackedTreeCount: baseline.trackedTreeCount, protectedBehaviorCount: baseline.behaviors.length, impactEdgeCount: baseline.impactEdges.length, state: "final" } : null;
}
