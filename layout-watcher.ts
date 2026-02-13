/**
 * Watches node_modules/.cache/test for empty manifest.json files. When one appears
 * (created by layout-loader when a layout is compiled), populates it with path,
 * timestamp, and count of sibling files in the segment. Invoked from next.config.ts
 * when NODE_ENV=development.
 */
import watcher from '@parcel/watcher';
import fs from 'fs';
import path from 'path';

const ROOT = process.cwd();
const CACHE_DIR = path.join(ROOT, 'node_modules/.cache/test');

function isEmpty(manifestPath: string): boolean {
  try {
    const content = fs.readFileSync(manifestPath, 'utf8');
    const parsed = JSON.parse(content);
    return !('path' in parsed || 'count' in parsed);
  } catch {
    return true;
  }
}

function countSiblings(segmentDir: string): number {
  const fullPath = path.join(ROOT, segmentDir);
  if (!fs.existsSync(fullPath)) return 0;
  return fs.readdirSync(fullPath, {withFileTypes: true}).filter((e) => e.isFile()).length;
}

function populateManifest(manifestPath: string) {
  if (!isEmpty(manifestPath)) return;
  const relativePath = path.relative(CACHE_DIR, path.dirname(manifestPath));
  const segmentDir = relativePath.replace(/\\/g, '/');
  const layoutPath = path.join(ROOT, segmentDir, 'layout.tsx');
  const layoutPathTs = path.join(ROOT, segmentDir, 'layout.ts');
  const layoutFile = fs.existsSync(layoutPath)
    ? layoutPath
    : fs.existsSync(layoutPathTs)
      ? layoutPathTs
      : layoutPath;
  const count = countSiblings(segmentDir);
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({path: layoutFile, timestamp: Date.now(), count}, null, 2)
  );
}

async function run() {
  fs.mkdirSync(CACHE_DIR, {recursive: true});
  const subscription = await watcher.subscribe(
    CACHE_DIR,
    (error, events) => {
      if (error) throw error;
      for (const event of events) {
        if (path.basename(event.path) === 'manifest.json') {
          if (event.type === 'create' || event.type === 'update') {
            populateManifest(event.path);
          }
        }
      }
    },
    {ignore: []}
  );

  process.on('SIGINT', () => subscription.unsubscribe());
}

run();
