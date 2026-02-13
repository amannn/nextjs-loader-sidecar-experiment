import {startWatcher} from './layout-watcher.ts';
import type {NextConfig} from 'next';

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
