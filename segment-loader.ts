import fs from 'fs';
import path from 'path';
import type {TurbopackLoaderContext} from './types.ts';

const CACHE_DIR = path.join(process.cwd(), 'node_modules/.cache/test');
const POLL_INTERVAL = 20;
const TIMEOUT = 10000;

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
      if (Date.now() - start > TIMEOUT)
        return reject(new Error(`Manifest timeout: ${manifestPath}`));
      setTimeout(check, POLL_INTERVAL);
    };
    check();
  });
}

export default function segmentLoader(
  this: TurbopackLoaderContext<{}>,
  source: string
) {
  const callback = this.async();
  const layoutDir = path.dirname(this.resourcePath);
  const segmentDir = path.relative(process.cwd(), layoutDir);
  const manifestPath = path.join(CACHE_DIR, segmentDir, 'manifest.json');
  const importPath = `.cache/test/${segmentDir.replace(/\\/g, '/')}/manifest.json`;

  const outDir = path.dirname(manifestPath);
  fs.mkdirSync(outDir, {recursive: true});
  if (!fs.existsSync(manifestPath)) {
    fs.writeFileSync(manifestPath, '{}');
  }

  const result = `
import manifest from '${importPath}';
console.log(manifest);

${source}
`;

  waitForManifest(manifestPath)
    .then(() => {
      callback(null, result);
    })
    .catch((error) => callback(error));
}
