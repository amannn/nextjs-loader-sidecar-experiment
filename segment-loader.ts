import fs from 'fs';
import path from 'path';
import {requestManifestBuild} from './layout-watcher.ts';
import type {TurbopackLoaderContext} from './types.ts';

const CACHE_DIR = path.join(process.cwd(), 'node_modules/.cache/test');
const POLL_INTERVAL = 10;
const TIMEOUT = 10000;
const DEBUG_LOG_PATH = '/tmp/segment-manifest.log';
const DEBUG_MODE = process.env.SEGMENT_MANIFEST_DEBUG === '1';

type ManifestRequestMessage = {
  force: boolean;
  manifestPath: string;
  type: 'segment-manifest-request';
};

type SegmentManifest = {
  entries: Array<string>;
  files: Record<string, unknown>;
};

function logWithTimestamp(scope: string, message: string): void {
  if (!DEBUG_MODE) return;
  fs.appendFileSync(
    DEBUG_LOG_PATH,
    `${new Date().toISOString()} [${scope}] ${message}\n`
  );
}

function isPopulated(manifestPath: string): boolean {
  try {
    const content = fs.readFileSync(manifestPath, 'utf8');
    const parsed = JSON.parse(content);
    return typeof parsed === 'object' && parsed !== null && 'files' in parsed;
  } catch {
    return false;
  }
}

function waitForManifest(manifestPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (isPopulated(manifestPath)) return resolve();
      const elapsed = Date.now() - start;
      if (elapsed > TIMEOUT) {
        return reject(
          new Error(`Manifest timeout after ${elapsed}ms: ${manifestPath}`)
        );
      }
      setTimeout(check, POLL_INTERVAL);
    };
    check();
  });
}

function parseManifestSource(manifestSource: string): SegmentManifest | null {
  try {
    const parsedManifest = JSON.parse(manifestSource) as unknown;
    if (
      typeof parsedManifest !== 'object' ||
      parsedManifest === null ||
      !('files' in parsedManifest) ||
      !('entries' in parsedManifest)
    ) {
      return null;
    }
    const parsedManifestRecord = parsedManifest as Record<string, unknown>;
    if (
      !Array.isArray(parsedManifestRecord.entries) ||
      typeof parsedManifestRecord.files !== 'object' ||
      parsedManifestRecord.files === null
    ) {
      return null;
    }
    return parsedManifest as SegmentManifest;
  } catch {
    return null;
  }
}

function resolveProjectFilePath(relativeFilePath: string): string | null {
  if (path.isAbsolute(relativeFilePath)) return null;
  const normalizedPath = path.normalize(relativeFilePath);
  if (normalizedPath.startsWith('..')) return null;
  return path.join(process.cwd(), normalizedPath);
}

function getManifestDependencyPaths(manifestSource: string): Array<string> {
  const parsedManifest = parseManifestSource(manifestSource);
  if (!parsedManifest) return [];

  const dependencyPaths = new Set<string>();
  for (const entryPath of parsedManifest.entries) {
    const resolvedPath = resolveProjectFilePath(entryPath);
    if (resolvedPath) dependencyPaths.add(resolvedPath);
  }
  for (const filePath of Object.keys(parsedManifest.files)) {
    const resolvedPath = resolveProjectFilePath(filePath);
    if (resolvedPath) dependencyPaths.add(resolvedPath);
  }

  return Array.from(dependencyPaths).sort((leftPath, rightPath) =>
    leftPath.localeCompare(rightPath)
  );
}

function requestManifestGeneration(manifestPath: string): void {
  const requestMessage: ManifestRequestMessage = {
    force: true,
    manifestPath,
    type: 'segment-manifest-request'
  };

  logWithTimestamp('loader', `request generation ${manifestPath}`);
  try {
    if (typeof process.send === 'function') {
      process.send(requestMessage);
      logWithTimestamp('loader', `sent ipc request ${manifestPath}`);
    } else {
      logWithTimestamp('loader', `ipc unavailable ${manifestPath}`);
    }
  } catch (error) {
    logWithTimestamp('loader', `ipc request failed ${String(error)}`);
  }
  requestManifestBuild(manifestPath);
  logWithTimestamp('loader', `direct request ${manifestPath}`);
}

export default function segmentLoader(
  this: TurbopackLoaderContext<{}>,
  source: string
) {
  const callback = this.async();
  const layoutDir = path.dirname(this.resourcePath);
  const segmentDir = path.relative(process.cwd(), layoutDir);
  const manifestPath = path.join(CACHE_DIR, segmentDir, 'manifest.json');
  requestManifestGeneration(manifestPath);

  waitForManifest(manifestPath)
    .then(() => {
      const manifestSource = fs.readFileSync(manifestPath, 'utf8');
      const dependencyPaths = getManifestDependencyPaths(manifestSource);
      for (const dependencyPath of dependencyPaths) {
        if (fs.existsSync(dependencyPath)) this.addDependency(dependencyPath);
        else this.addMissingDependency(dependencyPath);
      }
      return manifestSource;
    })
    .then((manifestSource) => {
      const result = source.replace(
        '  {children}',
        `<pre>{\`${manifestSource}\`}</pre>{children}`
      );
      logWithTimestamp('loader', `manifest ready ${manifestPath}`);
      callback(null, result);
    })
    .catch((error) => {
      logWithTimestamp('loader', `manifest wait failed ${String(error)}`);
      callback(error);
    });
}
