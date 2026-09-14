import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e', workers: 1, timeout: 30000,
  use: { baseURL: 'http://127.0.0.1:4317', channel: 'chrome', headless: true, viewport: { width: 1280, height: 900 }, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
