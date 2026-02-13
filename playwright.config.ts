import {defineConfig} from '@playwright/test';

export default defineConfig({
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  testDir: './tests/integration',
  timeout: 30_000,
  use: {
    baseURL: 'http://127.0.0.1:3100',
    trace: 'on-first-retry'
  },
  webServer: {
    command: 'pnpm dev -- --turbopack --port 3100',
    port: 3100,
    reuseExistingServer: false,
    timeout: 120_000
  },
  workers: 1
});
