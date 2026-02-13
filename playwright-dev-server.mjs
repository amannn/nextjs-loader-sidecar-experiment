import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const devPort = process.env.PLAYWRIGHT_DEV_PORT ?? '3100';
const cacheDir = path.join(process.cwd(), 'node_modules', '.cache', 'test');
const startupMarkerPath = path.join(cacheDir, 'startup-stale-marker.txt');

fs.mkdirSync(cacheDir, {recursive: true});
fs.writeFileSync(startupMarkerPath, `stale:${Date.now()}\n`, 'utf8');

const devProcess = spawn(
  'pnpm',
  ['exec', 'next', 'dev', '--turbopack', '--port', devPort],
  {
  shell: process.platform === 'win32',
  stdio: 'inherit'
  }
);

process.on('SIGINT', () => {
  devProcess.kill('SIGINT');
});

process.on('SIGTERM', () => {
  devProcess.kill('SIGTERM');
});

devProcess.on('exit', (exitCode) => {
  process.exit(exitCode ?? 1);
});
