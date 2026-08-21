import { defineConfig } from '@playwright/test';

/**
 * UI-level end-to-end tests. Opt-in, because they need a browser download
 * (`npx playwright install chromium`) and a running server:
 *
 *   docker compose up -d
 *   BASE_URL=http://127.0.0.1:3000 ADMIN_PASSWORD=... npm run test:e2e
 *
 * The protocol, arbiter and recovery paths are already covered headlessly by
 * apps/server/src/test/integration.test.ts against a real Chromium; these tests
 * cover the part only a browser can: the React client, canvas rendering and DOM
 * event translation.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: process.env.BASE_URL ?? 'http://127.0.0.1:3000',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
});
