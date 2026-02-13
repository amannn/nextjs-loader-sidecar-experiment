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
  manifestPath: string;
  type: 'segment-manifest-request';
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

function requestManifestGeneration(manifestPath: string): void {
  const requestMessage: ManifestRequestMessage = {
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
  if (!isPopulated(manifestPath)) requestManifestGeneration(manifestPath);

  waitForManifest(manifestPath)
    .then(() => {
      this.addDependency(manifestPath);
      const manifestSource = fs.readFileSync(manifestPath, 'utf8');
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
