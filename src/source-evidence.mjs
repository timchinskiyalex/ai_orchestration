import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { documentIdForPath } from "./product-blueprint.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const digestPattern = /^[a-f0-9]{64}$/;

export function normalizeSourceText(text) {
  return String(text).replace(/\r\n?/g, "\n");
}

export function sourceLines(text) {
  return normalizeSourceText(text).split("\n");
}

export function sourceFragmentDigest(text, startLine, endLine) {
  return sha256(sourceLines(text).slice(startLine - 1, endLine).join("\n"));
}

function provenanceError(message) {
  throw new Error(`source_provenance: ${message}`);
}

function isInside(root, candidate) {
  const relation = relative(root, candidate);
  return relation && !relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation);
}

function safeInventoryPath(path) {
  if (typeof path !== "string" || !path || isAbsolute(path) || path.includes("\\")) return false;
  return path.split("/").every((part) => part && part !== "." && part !== "..");
}

function loadInventory({ repository, documentationDir }) {
  const repositoryRoot = resolve(repository);
  const documentationRoot = resolve(repositoryRoot, documentationDir);
  if (!isInside(repositoryRoot, documentationRoot)) provenanceError("documentation directory escapes the controller repository");
  const inventoryPath = join(documentationRoot, "inventory.json");
  if (!existsSync(inventoryPath)) provenanceError("controller documentation inventory is missing; re-import documentation before Bootstrap");
  let inventory;
  try { inventory = JSON.parse(readFileSync(inventoryPath, "utf8")); }
  catch { provenanceError("controller documentation inventory is unreadable; re-import documentation before Bootstrap"); }
  if (!Array.isArray(inventory.files) || !inventory.files.length) provenanceError("controller documentation inventory has no source files; re-import documentation before Bootstrap");
  const documents = new Map();
  for (const file of inventory.files) {
    if (!file || !safeInventoryPath(file.path) || typeof file.documentId !== "string" || !digestPattern.test(file.sha256 ?? "")) provenanceError("controller documentation inventory has an unsafe source entry; re-import documentation before Bootstrap");
    if (file.documentId !== documentIdForPath(file.path)) provenanceError(`inventory document identity is invalid for '${file.path}'`);
    if (documents.has(file.documentId)) provenanceError(`inventory duplicates document '${file.documentId}'`);
    const absolutePath = resolve(documentationRoot, file.path);
    if (!isInside(documentationRoot, absolutePath)) provenanceError(`inventory path escapes documentation root for '${file.documentId}'`);
    documents.set(file.documentId, { documentId: file.documentId, path: file.path, sha256: file.sha256, absolutePath });
  }
  return { documentationRoot, documents };
}

export function createImportedSourceResolver(context) {
  const { documentationRoot, documents } = loadInventory(context);
  const sourceDocuments = [...documents.values()].map(({ documentId, path, sha256 }) => ({ documentId, path, sha256 }));
  const realDocumentationRoot = realpathSync(documentationRoot);

  function readDocument(documentId) {
    const document = documents.get(documentId);
    if (!document) provenanceError(`document '${String(documentId)}' is absent from the controller inventory`);
    if (!existsSync(document.absolutePath) || lstatSync(document.absolutePath).isSymbolicLink()) provenanceError(`imported document '${documentId}' is unavailable or substituted; re-import documentation before Bootstrap`);
    const realDocumentPath = realpathSync(document.absolutePath);
    if (!isInside(realDocumentationRoot, realDocumentPath)) provenanceError(`imported document '${documentId}' escapes the controller intake root`);
    const text = readFileSync(document.absolutePath, "utf8");
    if (sha256(normalizeSourceText(text)) !== document.sha256) provenanceError(`imported document '${documentId}' no longer matches its controller inventory; re-import documentation before Bootstrap`);
    return text;
  }

  function verify(ref, label = "source reference") {
    if (!ref || typeof ref !== "object" || Array.isArray(ref)) provenanceError(`${label} is not an object`);
    if (typeof ref.documentId !== "string" || !documents.has(ref.documentId)) provenanceError(`${label} names a document absent from the controller inventory`);
    if (!Number.isInteger(ref.startLine) || !Number.isInteger(ref.endLine)) provenanceError(`${label} must use integer startLine and endLine`);
    if (ref.startLine < 1 || ref.endLine < ref.startLine) provenanceError(`${label} has an invalid line range`);
    if (!digestPattern.test(ref.excerptDigest ?? "")) provenanceError(`${label} has an invalid excerptDigest`);
    const lines = sourceLines(readDocument(ref.documentId));
    if (ref.endLine > lines.length) provenanceError(`${label} line range is outside imported document '${ref.documentId}'`);
    const actualDigest = sha256(lines.slice(ref.startLine - 1, ref.endLine).join("\n"));
    if (actualDigest !== ref.excerptDigest) provenanceError(`${label} digest does not match imported document '${ref.documentId}'`);
    return { documentId: ref.documentId, startLine: ref.startLine, endLine: ref.endLine, excerptDigest: actualDigest };
  }

  return Object.freeze({ sourceDocuments: Object.freeze(sourceDocuments), verify });
}
