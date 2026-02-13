import watcher from '@parcel/watcher';
import {parseSync} from '@swc/core';
import fs from 'fs';
import {builtinModules, createRequire} from 'module';
import path from 'path';

const ROOT = process.cwd();
const SRC_DIR = path.join(ROOT, 'src');
const APP_DIR = path.join(SRC_DIR, 'app');
const CACHE_DIR = path.join(ROOT, 'node_modules/.cache/test');
const RESOLVE_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.cjs', '.json'];
const PARSEABLE_EXTENSIONS = new Set(['.tsx', '.ts', '.jsx', '.js', '.mjs', '.cjs']);
const ENTRY_FILENAMES = new Set(['layout.tsx', 'page.tsx']);
const NODE_BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map((builtinModule) => `node:${builtinModule}`)
]);
const runtimeRequire = createRequire(path.join(ROOT, 'package.json'));

type CachedFile = {
  imports: Array<string>;
  lines: number;
};

type SegmentDefinition = {
  entries: Array<string>;
  id: string;
};

type SegmentManifestFile = {
  imports: Array<string>;
  lines: number;
};

type SegmentManifest = {
  entries: Array<string>;
  files: Record<string, SegmentManifestFile>;
  segment: string;
  updatedAt: number;
};

type WatchEvent = {
  path: string;
  type: string;
};

const cachedFiles = new Map<string, CachedFile>();
const fileToSegments = new Map<string, Set<string>>();
const segmentDefinitions = new Map<string, SegmentDefinition>();
const segmentToFiles = new Map<string, Set<string>>();

function toPosixPath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

function normalizeFilePath(filePath: string): string {
  return path.normalize(path.resolve(filePath));
}

function isWithin(directoryPath: string, filePath: string): boolean {
  const relativePath = path.relative(directoryPath, filePath);
  return (
    relativePath === '' ||
    (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))
  );
}

function countLines(sourceCode: string): number {
  if (sourceCode.length === 0) return 0;
  return sourceCode.split(/\r?\n/).length;
}

function readStringLiteral(node: unknown): string | null {
  if (!node || typeof node !== 'object') return null;
  const nodeRecord = node as Record<string, unknown>;
  if (nodeRecord.type === 'StringLiteral' && typeof nodeRecord.value === 'string') {
    return nodeRecord.value;
  }
  if (nodeRecord.type === 'Literal' && typeof nodeRecord.value === 'string') {
    return nodeRecord.value;
  }
  return null;
}

function readCallArgumentString(argumentNodes: unknown): string | null {
  if (!Array.isArray(argumentNodes) || argumentNodes.length === 0) return null;
  const firstArgument = argumentNodes[0];
  if (!firstArgument || typeof firstArgument !== 'object') return null;
  const firstArgumentRecord = firstArgument as Record<string, unknown>;
  if ('expression' in firstArgumentRecord) {
    return readStringLiteral(firstArgumentRecord.expression);
  }
  return readStringLiteral(firstArgument);
}

function isIdentifier(node: unknown, value: string): boolean {
  if (!node || typeof node !== 'object') return false;
  const nodeRecord = node as Record<string, unknown>;
  return nodeRecord.type === 'Identifier' && nodeRecord.value === value;
}

function isImportCallee(node: unknown): boolean {
  if (!node || typeof node !== 'object') return false;
  const nodeRecord = node as Record<string, unknown>;
  return nodeRecord.type === 'Import';
}

function collectImportSpecifiers(sourceCode: string, filePath: string): Array<string> {
  const extension = path.extname(filePath).toLowerCase();
  if (!PARSEABLE_EXTENSIONS.has(extension)) return [];

  let ast: unknown;
  try {
    if (extension === '.ts' || extension === '.tsx') {
      ast = parseSync(sourceCode, {
        decorators: true,
        syntax: 'typescript',
        tsx: extension === '.tsx'
      });
    } else {
      ast = parseSync(sourceCode, {
        jsx: extension === '.js' || extension === '.jsx',
        syntax: 'ecmascript'
      });
    }
  } catch {
    return [];
  }

  const importSpecifiers = new Set<string>();
  const pendingNodes: Array<unknown> = [ast];

  while (pendingNodes.length > 0) {
    const currentNode = pendingNodes.pop();
    if (!currentNode || typeof currentNode !== 'object') continue;

    if (Array.isArray(currentNode)) {
      for (const node of currentNode) pendingNodes.push(node);
      continue;
    }

    const nodeRecord = currentNode as Record<string, unknown>;
    const nodeType = nodeRecord.type;

    if (
      (nodeType === 'ImportDeclaration' ||
        nodeType === 'ExportAllDeclaration' ||
        nodeType === 'ExportNamedDeclaration') &&
      typeof nodeRecord.source === 'object'
    ) {
      const sourceValue = readStringLiteral(nodeRecord.source);
      if (sourceValue) importSpecifiers.add(sourceValue);
    }

    if (nodeType === 'CallExpression') {
      const isRequireCall = isIdentifier(nodeRecord.callee, 'require');
      const isDynamicImportCall = isImportCallee(nodeRecord.callee);
      if (isRequireCall || isDynamicImportCall) {
        const sourceValue = readCallArgumentString(nodeRecord.arguments);
        if (sourceValue) importSpecifiers.add(sourceValue);
      }
    }

    if (nodeType === 'ImportExpression') {
      const sourceValue = readStringLiteral(nodeRecord.source);
      if (sourceValue) importSpecifiers.add(sourceValue);
    }

    for (const childNode of Object.values(nodeRecord)) pendingNodes.push(childNode);
  }

  return Array.from(importSpecifiers);
}

function normalizeImportSpecifier(importSpecifier: string): string {
  if (importSpecifier.startsWith('@src/')) {
    return path.join(SRC_DIR, importSpecifier.slice('@src/'.length));
  }
  if (importSpecifier.startsWith('@/')) {
    return path.join(SRC_DIR, importSpecifier.slice(2));
  }
  return importSpecifier;
}

function buildResolveCandidates(
  importSpecifier: string,
  sourceDirectory: string
): Array<string> {
  const isPathLike =
    importSpecifier.startsWith('./') ||
    importSpecifier.startsWith('../') ||
    path.isAbsolute(importSpecifier);

  if (!isPathLike) return [importSpecifier];

  const absolutePath = path.isAbsolute(importSpecifier)
    ? importSpecifier
    : path.resolve(sourceDirectory, importSpecifier);

  if (path.extname(absolutePath) !== '') return [absolutePath];

  const candidates = new Set<string>([absolutePath]);
  for (const extension of RESOLVE_EXTENSIONS) {
    candidates.add(`${absolutePath}${extension}`);
    candidates.add(path.join(absolutePath, `index${extension}`));
  }
  return Array.from(candidates);
}

function resolveImportPath(
  sourceFilePath: string,
  importSpecifier: string
): string | null {
  if (NODE_BUILTINS.has(importSpecifier)) return null;

  const normalizedSpecifier = normalizeImportSpecifier(importSpecifier);
  const sourceDirectory = path.dirname(sourceFilePath);
  const resolveCandidates = buildResolveCandidates(
    normalizedSpecifier,
    sourceDirectory
  );

  for (const resolveCandidate of resolveCandidates) {
    try {
      const resolvedPath = normalizeFilePath(
        runtimeRequire.resolve(resolveCandidate, {paths: [sourceDirectory]})
      );
      if (!isWithin(SRC_DIR, resolvedPath)) continue;
      return resolvedPath;
    } catch {
      // continue
    }
  }

  return null;
}

function getCachedFile(filePath: string): CachedFile {
  const normalizedPath = normalizeFilePath(filePath);
  const cached = cachedFiles.get(normalizedPath);
  if (cached) return cached;

  if (!fs.existsSync(normalizedPath)) {
    const missingFile: CachedFile = {imports: [], lines: 0};
    cachedFiles.set(normalizedPath, missingFile);
    return missingFile;
  }

  const sourceCode = fs.readFileSync(normalizedPath, 'utf8');
  const importSpecifiers = collectImportSpecifiers(sourceCode, normalizedPath);
  const resolvedImports = new Set<string>();

  for (const importSpecifier of importSpecifiers) {
    const resolvedImportPath = resolveImportPath(normalizedPath, importSpecifier);
    if (resolvedImportPath) resolvedImports.add(resolvedImportPath);
  }

  const cachedFile: CachedFile = {
    imports: Array.from(resolvedImports).sort(),
    lines: countLines(sourceCode)
  };
  cachedFiles.set(normalizedPath, cachedFile);
  return cachedFile;
}

function collectManifestPaths(
  directoryPath: string,
  manifestPaths: Array<string>
): void {
  if (!fs.existsSync(directoryPath)) return;
  const directoryEntries = fs.readdirSync(directoryPath, {withFileTypes: true});
  for (const directoryEntry of directoryEntries) {
    const fullPath = path.join(directoryPath, directoryEntry.name);
    if (directoryEntry.isDirectory()) {
      collectManifestPaths(fullPath, manifestPaths);
      continue;
    }
    if (directoryEntry.isFile() && directoryEntry.name === 'manifest.json') {
      manifestPaths.push(normalizeFilePath(fullPath));
    }
  }
}

function isManifestRequest(manifestPath: string): boolean {
  if (!fs.existsSync(manifestPath)) return true;
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return !(typeof parsed === 'object' && parsed !== null && 'files' in parsed);
  } catch {
    return true;
  }
}

function getSegmentIdFromManifestPath(manifestPath: string): string | null {
  const manifestDirectory = path.dirname(manifestPath);
  const relativeDirectory = toPosixPath(path.relative(CACHE_DIR, manifestDirectory));
  if (relativeDirectory.startsWith('..') || path.isAbsolute(relativeDirectory)) return null;
  return relativeDirectory;
}

function getSegmentEntries(segmentId: string): Array<string> {
  const segmentDirectory = path.join(ROOT, segmentId);
  const entries = new Set<string>();
  const layoutPath = normalizeFilePath(path.join(segmentDirectory, 'layout.tsx'));
  const pagePath = normalizeFilePath(path.join(segmentDirectory, 'page.tsx'));
  if (fs.existsSync(layoutPath)) entries.add(layoutPath);
  if (fs.existsSync(pagePath)) entries.add(pagePath);
  return Array.from(entries).sort();
}

function ensureSegmentDefinition(segmentId: string): SegmentDefinition | null {
  const entries = getSegmentEntries(segmentId);
  const hasLayoutEntry = entries.some(
    (entryPath) => path.basename(entryPath) === 'layout.tsx'
  );
  if (!hasLayoutEntry) {
    removeSegment(segmentId);
    return null;
  }
  const segmentDefinition: SegmentDefinition = {entries, id: segmentId};
  segmentDefinitions.set(segmentId, segmentDefinition);
  return segmentDefinition;
}

function getManifestPath(segmentId: string): string {
  return path.join(CACHE_DIR, segmentId, 'manifest.json');
}

function clearSegmentMembership(segmentId: string): void {
  const segmentFiles = segmentToFiles.get(segmentId);
  if (!segmentFiles) return;

  for (const filePath of segmentFiles) {
    const segments = fileToSegments.get(filePath);
    if (!segments) continue;
    segments.delete(segmentId);
    if (segments.size === 0) fileToSegments.delete(filePath);
  }

  segmentToFiles.delete(segmentId);
}

function removeSegment(segmentId: string): void {
  clearSegmentMembership(segmentId);
  segmentDefinitions.delete(segmentId);
  const manifestPath = getManifestPath(segmentId);
  if (fs.existsSync(manifestPath)) fs.rmSync(manifestPath, {force: true});
}

function writeManifest(
  segmentDefinition: SegmentDefinition,
  segmentFiles: Set<string>,
  segmentDependencies: Map<string, Array<string>>
): void {
  const fileManifestEntries: Record<string, SegmentManifestFile> = {};
  const sortedFiles = Array.from(segmentFiles).sort((leftPath, rightPath) =>
    leftPath.localeCompare(rightPath)
  );

  for (const filePath of sortedFiles) {
    const fileData = getCachedFile(filePath);
    const importedFiles = (segmentDependencies.get(filePath) ?? [])
      .filter((importPath) => segmentFiles.has(importPath))
      .map((importPath) => toPosixPath(path.relative(ROOT, importPath)))
      .sort();

    const relativeFilePath = toPosixPath(path.relative(ROOT, filePath));
    fileManifestEntries[relativeFilePath] = {
      imports: importedFiles,
      lines: fileData.lines
    };
  }

  const manifest: SegmentManifest = {
    entries: segmentDefinition.entries.map((entryPath) =>
      toPosixPath(path.relative(ROOT, entryPath))
    ),
    files: fileManifestEntries,
    segment: segmentDefinition.id,
    updatedAt: Date.now()
  };

  const manifestPath = getManifestPath(segmentDefinition.id);
  fs.mkdirSync(path.dirname(manifestPath), {recursive: true});
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

function buildSegment(segmentDefinition: SegmentDefinition): void {
  const visitedFiles = new Set<string>();
  const segmentDependencies = new Map<string, Array<string>>();
  const filesToVisit = Array.from(segmentDefinition.entries);

  while (filesToVisit.length > 0) {
    const nextFilePath = filesToVisit.pop();
    if (!nextFilePath) continue;
    const filePath = normalizeFilePath(nextFilePath);
    if (visitedFiles.has(filePath)) continue;
    if (!fs.existsSync(filePath)) continue;
    visitedFiles.add(filePath);

    const fileData = getCachedFile(filePath);
    segmentDependencies.set(filePath, fileData.imports);
    for (const importPath of fileData.imports) {
      if (!visitedFiles.has(importPath)) filesToVisit.push(importPath);
    }
  }

  clearSegmentMembership(segmentDefinition.id);
  segmentToFiles.set(segmentDefinition.id, visitedFiles);
  for (const filePath of visitedFiles) {
    if (!fileToSegments.has(filePath)) fileToSegments.set(filePath, new Set());
    fileToSegments.get(filePath)?.add(segmentDefinition.id);
  }

  writeManifest(segmentDefinition, visitedFiles, segmentDependencies);
}

function buildSegmentForId(segmentId: string): void {
  const segmentDefinition = ensureSegmentDefinition(segmentId);
  if (!segmentDefinition) return;
  buildSegment(segmentDefinition);
}

function processManifestRequest(manifestPath: string): void {
  const normalizedManifestPath = normalizeFilePath(manifestPath);
  if (path.basename(normalizedManifestPath) !== 'manifest.json') return;
  if (!isManifestRequest(normalizedManifestPath)) return;
  const segmentId = getSegmentIdFromManifestPath(normalizedManifestPath);
  if (!segmentId) return;
  buildSegmentForId(segmentId);
}

function processPendingManifestRequests(): void {
  const manifestPaths: Array<string> = [];
  collectManifestPaths(CACHE_DIR, manifestPaths);
  for (const manifestPath of manifestPaths.sort()) processManifestRequest(manifestPath);
}

function isEntryFile(filePath: string): boolean {
  if (!isWithin(APP_DIR, filePath)) return false;
  return ENTRY_FILENAMES.has(path.basename(filePath));
}

function getEntrySegmentId(filePath: string): string {
  return toPosixPath(path.relative(ROOT, path.dirname(filePath)));
}

function rebuildAllActiveSegments(): void {
  const segmentIds = Array.from(segmentDefinitions.keys()).sort();
  for (const segmentId of segmentIds) buildSegmentForId(segmentId);
}

function rebuildImpactedSegments(filePaths: Set<string>): void {
  const impactedSegments = new Set<string>();
  for (const filePath of filePaths) {
    const segments = fileToSegments.get(filePath);
    if (segments) {
      for (const segmentId of segments) impactedSegments.add(segmentId);
    }
    if (isEntryFile(filePath)) {
      const entrySegmentId = getEntrySegmentId(filePath);
      if (segmentDefinitions.has(entrySegmentId)) impactedSegments.add(entrySegmentId);
    }
  }

  const sortedImpactedSegments = Array.from(impactedSegments).sort();
  for (const segmentId of sortedImpactedSegments) buildSegmentForId(segmentId);
}

function handleSourceEvents(events: Array<WatchEvent>): void {
  if (events.length === 0) return;

  let hasCreateOrDelete = false;
  const changedFiles = new Set<string>();

  for (const event of events) {
    const changedFilePath = normalizeFilePath(event.path);
    changedFiles.add(changedFilePath);
    cachedFiles.delete(changedFilePath);
    if (event.type === 'create' || event.type === 'delete') hasCreateOrDelete = true;
  }

  if (hasCreateOrDelete) {
    rebuildAllActiveSegments();
    return;
  }

  rebuildImpactedSegments(changedFiles);
}

function handleManifestEvents(events: Array<WatchEvent>): void {
  if (events.length === 0) return;
  for (const event of events) {
    if (event.type !== 'create' && event.type !== 'update') continue;
    processManifestRequest(event.path);
  }
}

async function run() {
  fs.mkdirSync(CACHE_DIR, {recursive: true});
  processPendingManifestRequests();
  if (process.argv.includes('--once')) {
    return;
  }

  const subscriptions: Array<{unsubscribe: () => Promise<void> | void}> = [];

  const cacheSubscription = await watcher.subscribe(CACHE_DIR, (error, events) => {
    if (error) throw error;
    handleManifestEvents(events as Array<WatchEvent>);
  });
  subscriptions.push(cacheSubscription);

  if (fs.existsSync(SRC_DIR)) {
    const sourceSubscription = await watcher.subscribe(SRC_DIR, (error, events) => {
      if (error) throw error;
      handleSourceEvents(events as Array<WatchEvent>);
    });
    subscriptions.push(sourceSubscription);
  }

  const stop = () => {
    for (const subscription of subscriptions) void subscription.unsubscribe();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

run().catch((runError) => {
  console.error(runError);
  process.exitCode = 1;
});
