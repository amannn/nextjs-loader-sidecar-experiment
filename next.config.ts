import {spawn} from 'child_process';
import path from 'path';
import type {NextConfig} from 'next';

if (
  process.env.NODE_ENV === 'development' &&
  !process.env.LAYOUT_WATCHER_STARTED
) {
  process.env.LAYOUT_WATCHER_STARTED = '1';
  spawn('node', [path.join(process.cwd(), 'layout-watcher.ts')], {
    detached: true,
    stdio: 'ignore',
    cwd: process.cwd()
  }).unref();
}

const nextConfig: NextConfig = {
  turbopack: {
    rules: {
      '**/layout.tsx': {
        loaders: [
          {
            loader: './segment-loader-v2.ts'
          }
        ]
      }
    }
  }
};

export default nextConfig;
