import fs from 'fs';
import path from 'path';
import {startWatcher} from './layout-watcher.ts';
import type {NextConfig} from 'next';

const cacheTestDir = path.join(process.cwd(), 'node_modules', '.cache', 'test');
if (fs.existsSync(cacheTestDir)) {
  fs.rmSync(cacheTestDir, {recursive: true});
}

if (process.env.NODE_ENV === 'development') {
  void startWatcher().catch((watcherError) => {
    console.error(watcherError);
  });
}

const nextConfig: NextConfig = {
  turbopack: {
    rules: {
      '**/layout.tsx': {
        loaders: [
          {
            loader: './segment-loader.ts'
          }
        ]
      }
    }
  }
};

export default nextConfig;
