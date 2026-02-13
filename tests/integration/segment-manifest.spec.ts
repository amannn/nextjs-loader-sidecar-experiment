import {expect, test} from '@playwright/test';
import type {Page} from '@playwright/test';
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

function parseManifestSource(manifestSource: string): SegmentManifest | null {
  try {
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

async function readRenderedManifest(
  page: Page,
  segment: string
): Promise<SegmentManifest | null> {
  const renderedEntries = await page.locator('pre').allTextContents();
  for (const renderedEntry of renderedEntries) {
    const parsedManifest = parseManifestSource(renderedEntry);
    if (parsedManifest && parsedManifest.segment === segment) return parsedManifest;
  }
  return null;
}

async function waitForRenderedManifest(
  page: Page,
  segment: string
): Promise<SegmentManifest> {
  const startTime = Date.now();
  const timeout = 10_000;
  while (Date.now() - startTime <= timeout) {
    const manifest = await readRenderedManifest(page, segment);
    if (manifest) return manifest;
    await delay(25);
  }

  throw new Error(`Timed out waiting for rendered manifest: ${segment}`);
}

async function waitForRenderedManifestUpdate(
  page: Page,
  segment: string,
  previousUpdatedAt: number
): Promise<SegmentManifest> {
  const startTime = Date.now();
  const timeout = 10_000;
  while (Date.now() - startTime <= timeout) {
    const manifest = await readRenderedManifest(page, segment);
    if (manifest && manifest.updatedAt > previousUpdatedAt) return manifest;
    await delay(25);
  }

  throw new Error(`Timed out waiting for rendered manifest update: ${segment}`);
}

test.describe.configure({mode: 'serial'});

test('Dev startup clears cache marker', async () => {
  expect(await fileExists(startupMarkerPath)).toBe(false);
});

test('Rendering / writes only root manifest', async ({request}) => {
  await fs.rm(testManifestPath, {force: true});

  const response = await request.get('/');
  expect(response.ok()).toBe(true);
  await response.text();

  const rootManifest = await waitForManifest(rootManifestPath);
  expect(rootManifest.segment).toBe('src/app');

  await delay(200);
  expect(await fileExists(testManifestPath)).toBe(false);
});

test('Rendering /test writes both manifests', async ({request}) => {
  await fs.rm(testManifestPath, {force: true});

  const response = await request.get('/test');
  expect(response.ok()).toBe(true);
  await response.text();

  const rootManifest = await waitForManifest(rootManifestPath);
  const nestedManifest = await waitForManifest(testManifestPath);

  expect(rootManifest.segment).toBe('src/app');
  expect(nestedManifest.segment).toBe('src/app/test');
});

test('Editing a file updates rendered manifest automatically', async ({page}) => {
  const componentPath = path.join(process.cwd(), 'src', 'app', 'test', 'Comp.tsx');
  const originalComponentSource = await fs.readFile(componentPath, 'utf8');
  const markerText = `Comp manifest marker ${Date.now()}`;
  const updatedComponentSource = originalComponentSource.replace(
    '<h1>Comp</h1>',
    `<h1>${markerText}</h1>`
  );

  expect(updatedComponentSource).not.toBe(originalComponentSource);

  await page.goto('/test');
  await expect(page.getByRole('heading', {name: 'Test Page'})).toBeVisible();

  const initialManifest = await waitForRenderedManifest(page, 'src/app/test');

  try {
    await fs.writeFile(componentPath, updatedComponentSource, 'utf8');
    const updatedManifest = await waitForRenderedManifestUpdate(
      page,
      'src/app/test',
      initialManifest.updatedAt
    );
    expect(updatedManifest.updatedAt).toBeGreaterThan(initialManifest.updatedAt);
  } finally {
    await fs.writeFile(componentPath, originalComponentSource, 'utf8');
  }
});

test('Removing a segment dependency updates rendered manifest files', async ({page}) => {
  const pagePath = path.join(process.cwd(), 'src', 'app', 'test', 'page.tsx');
  const originalPageSource = await fs.readFile(pagePath, 'utf8');
  const updatedPageSource = originalPageSource
    .replace("import Comp from './Comp';", '')
    .replace('      <Comp />', '      <p>No comp</p>');

  expect(updatedPageSource).not.toBe(originalPageSource);
  expect(updatedPageSource).not.toContain("import Comp from './Comp';");

  await page.goto('/test');
  await expect(page.getByRole('heading', {name: 'Test Page'})).toBeVisible();

  const initialManifest = await waitForRenderedManifest(page, 'src/app/test');
  expect(initialManifest.files['src/app/test/Comp.tsx']).toBeDefined();

  try {
    await fs.writeFile(pagePath, updatedPageSource, 'utf8');
    const updatedManifest = await waitForRenderedManifestUpdate(
      page,
      'src/app/test',
      initialManifest.updatedAt
    );
    expect(updatedManifest.files['src/app/test/Comp.tsx']).toBeUndefined();
    await expect(page.getByText('No comp')).toBeVisible();
  } finally {
    await fs.writeFile(pagePath, originalPageSource, 'utf8');
  }
});

test('Adding a segment dependency updates rendered manifest files', async ({page}) => {
  const pagePath = path.join(process.cwd(), 'src', 'app', 'test', 'page.tsx');
  const addedComponentPath = path.join(
    process.cwd(),
    'src',
    'app',
    'test',
    'ManifestAddedComp.tsx'
  );
  const originalPageSource = await fs.readFile(pagePath, 'utf8');
  const updatedPageSource = originalPageSource
    .replace(
      "import Comp from './Comp';",
      "import Comp from './Comp';\nimport ManifestAddedComp from './ManifestAddedComp';"
    )
    .replace('      <Comp />', '      <Comp />\n      <ManifestAddedComp />');
  const addedComponentSource = `export default function ManifestAddedComp() {
  return (
    <div>
      <h2>Manifest added component</h2>
    </div>
  );
}
`;

  expect(updatedPageSource).not.toBe(originalPageSource);

  await fs.rm(addedComponentPath, {force: true});
  await page.goto('/test');
  await expect(page.getByRole('heading', {name: 'Test Page'})).toBeVisible();

  const initialManifest = await waitForRenderedManifest(page, 'src/app/test');
  expect(initialManifest.files['src/app/test/ManifestAddedComp.tsx']).toBeUndefined();

  try {
    await fs.writeFile(addedComponentPath, addedComponentSource, 'utf8');
    await fs.writeFile(pagePath, updatedPageSource, 'utf8');
    const updatedManifest = await waitForRenderedManifestUpdate(
      page,
      'src/app/test',
      initialManifest.updatedAt
    );
    expect(updatedManifest.files['src/app/test/ManifestAddedComp.tsx']).toBeDefined();
    await expect(page.getByRole('heading', {name: 'Manifest added component'})).toBeVisible();
  } finally {
    await fs.writeFile(pagePath, originalPageSource, 'utf8');
    await fs.rm(addedComponentPath, {force: true});
  }
});

test('Editing a root segment file updates rendered root manifest', async ({page}) => {
  const rootPagePath = path.join(process.cwd(), 'src', 'app', 'page.tsx');
  const originalRootPageSource = await fs.readFile(rootPagePath, 'utf8');
  const markerText = `Hello world manifest marker ${Date.now()}`;
  const updatedRootPageSource = originalRootPageSource.replace(
    'Hello world!',
    markerText
  );

  expect(updatedRootPageSource).not.toBe(originalRootPageSource);

  await page.goto('/test');
  await expect(page.getByRole('heading', {name: 'Test Page'})).toBeVisible();

  const initialRootManifest = await waitForRenderedManifest(page, 'src/app');

  try {
    await fs.writeFile(rootPagePath, updatedRootPageSource, 'utf8');
    const updatedRootManifest = await waitForRenderedManifestUpdate(
      page,
      'src/app',
      initialRootManifest.updatedAt
    );
    expect(updatedRootManifest.updatedAt).toBeGreaterThan(initialRootManifest.updatedAt);
  } finally {
    await fs.writeFile(rootPagePath, originalRootPageSource, 'utf8');
  }
});
