import { defineConfig } from '@playwright/test';

const rawOrigin = process.env.MOTIVE_ACCOUNT_TEST_ORIGIN ?? 'http://127.0.0.1:4317';
const origin = new URL(rawOrigin);
if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1'
    || origin.pathname !== '/' || origin.search || origin.hash
    || !origin.port || Number(origin.port) < 1024 || Number(origin.port) > 65535) {
  throw new Error('MOTIVE_ACCOUNT_TEST_ORIGIN must be an exact 127.0.0.1 HTTP origin with a non-privileged port.');
}

export default defineConfig({
  testDir: '.',
  testMatch: 'accounts.spec.ts',
  workers: 1,
  timeout: 30_000,
  use: {
    baseURL: origin.origin,
    channel: 'chrome',
    headless: true,
    viewport: { width: 1280, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});