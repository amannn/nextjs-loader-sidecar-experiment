import {expect, test} from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

const cacheDir = path.join(process.cwd(), 'node_modules', '.cache', 'test');
const startupMarkerPath = path.join(cacheDir, 'startup-stale-marker.txt');
const rootManifestPath = path.join(cacheDir, 'src', 'app', 'manifest.json');
const testManifestPath = path.join(cacheDir, 'src', 'app', 'test', 'manifest.json');

type ManifestFile = {
  imports: Array<string>;
  lines: number;
};

type SegmentManifest = {
  entries: Array<string>;
  files: Record<string, ManifestFile>;
  segment: string;
  updatedAt: number;
};

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readManifest(manifestPath: string): Promise<SegmentManifest | null> {
  try {
    const manifestSource = await fs.readFile(manifestPath, 'utf8');
    const parsedManifest = JSON.parse(manifestSource) as unknown;
    if (
      typeof parsedManifest === 'object' &&
      parsedManifest !== null &&
      'files' in parsedManifest &&
      'segment' in parsedManifest
    ) {
      return parsedManifest as SegmentManifest;
    }
  } catch {
    return null;
  }

  return null;
}

async function waitForManifest(manifestPath: string): Promise<SegmentManifest> {
  const startTime = Date.now();
  const timeout = 10_000;
  while (Date.now() - startTime <= timeout) {
    const manifest = await readManifest(manifestPath);
    if (manifest) return manifest;
    await delay(25);
  }

  throw new Error(`Timed out waiting for manifest: ${manifestPath}`);
}

async function resetManifests(): Promise<void> {
  await fs.rm(rootManifestPath, {force: true});
  await fs.rm(testManifestPath, {force: true});
}

test.describe.configure({mode: 'serial'});

test('Dev startup clears cache marker', async () => {
  expect(await fileExists(startupMarkerPath)).toBe(false);
});

test('Rendering / writes only root manifest', async ({request}) => {
  await resetManifests();

  const response = await request.get('/');
  expect(response.ok()).toBe(true);
  await response.text();

  const rootManifest = await waitForManifest(rootManifestPath);
  expect(rootManifest.segment).toBe('src/app');

  await delay(200);
  expect(await fileExists(testManifestPath)).toBe(false);
});

test('Rendering /test writes both manifests', async ({request}) => {
  await resetManifests();

  const response = await request.get('/test');
  expect(response.ok()).toBe(true);
  await response.text();

  const rootManifest = await waitForManifest(rootManifestPath);
  const nestedManifest = await waitForManifest(testManifestPath);

  expect(rootManifest.segment).toBe('src/app');
  expect(nestedManifest.segment).toBe('src/app/test');
});
