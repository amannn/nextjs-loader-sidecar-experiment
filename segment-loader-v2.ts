import {execFileSync} from 'child_process';
import fs from 'fs';
import path from 'path';
import type {TurbopackLoaderContext} from './types.ts';

const CACHE_DIR = path.join(process.cwd(), 'node_modules/.cache/test');
const POLL_INTERVAL = 20;
const TIMEOUT = 10000;
const WATCHER_SCRIPT = path.join(process.cwd(), 'layout-watcher.ts');
const DEBUG_LOG_PATH = '/tmp/segment-manifest.log';
const DEBUG_MODE = process.env.SEGMENT_MANIFEST_DEBUG === '1';

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
  logWithTimestamp('loader', `request generation ${manifestPath}`);
  try {
    execFileSync('node', [WATCHER_SCRIPT, '--once', '--manifest', manifestPath], {
      cwd: process.cwd(),
      stdio: 'ignore'
    });
  } catch (error) {
    logWithTimestamp('loader', `request generation failed ${String(error)}`);
  }
}

export default function segmentLoaderV2(
  this: TurbopackLoaderContext<{}>,
  source: string
) {
  const callback = this.async();
  const layoutDir = path.dirname(this.resourcePath);
  const segmentDir = path.relative(process.cwd(), layoutDir);
  const manifestPath = path.join(CACHE_DIR, segmentDir, 'manifest.json');
  const outDir = path.dirname(manifestPath);
  fs.mkdirSync(outDir, {recursive: true});
  if (!fs.existsSync(manifestPath)) {
    fs.writeFileSync(manifestPath, '{}');
    logWithTimestamp('loader', `created request stub ${manifestPath}`);
  }
  if (!isPopulated(manifestPath)) requestManifestGeneration(manifestPath);

  waitForManifest(manifestPath)
    .then(() => {
      const manifestSource = fs.readFileSync(manifestPath, 'utf8');
      const result = `
const manifest = ${manifestSource};
console.log(manifest);

${source}
`;
      logWithTimestamp('loader', `manifest ready ${manifestPath}`);
      callback(null, result);
    })
    .catch((error) => {
      logWithTimestamp('loader', `manifest wait failed ${String(error)}`);
      callback(error);
    });
}
