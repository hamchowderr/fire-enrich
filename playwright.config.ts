/**
 * Browser smoke test: the real UI against the built app on port 3601, with every outside
 * service replaced.
 *
 * - Models: AIMock on port 4031, serving `fixtures/*.json`.
 * - Firecrawl: `tests/e2e/firecrawl-stub.mjs` on port 4131,
 *   serving the recordings in `tests/fixtures/firecrawl/`.
 * - Storage: a local SQLite file; Dolt is switched off.
 *
 * Both mocks are started by `tests/e2e/global-setup.ts` and stopped by
 * `tests/e2e/global-teardown.ts`. The app is built and served with
 * `next start` (a production build, so React StrictMode does not start the
 * enrichment effect twice). Set `E2E_SKIP_BUILD=1` when `.next` already holds
 * a build, as in CI after its build step.
 */
import { mkdirSync } from 'node:fs';

import { defineConfig, devices } from '@playwright/test';

import { AIMOCK_PORT, APP_PORT, FIRECRAWL_STUB_PORT } from './tests/e2e/ports';

// libSQL opens the database file without creating its directory.
mkdirSync('.mastra', { recursive: true });

const start = `npx next start -p ${APP_PORT} -H 127.0.0.1`;

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  outputDir: 'test-results',
  globalSetup: './tests/e2e/global-setup.ts',
  globalTeardown: './tests/e2e/global-teardown.ts',
  use: {
    baseURL: `http://127.0.0.1:${APP_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'on',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1600, height: 1000 } } }],
  webServer: {
    command: process.env.E2E_SKIP_BUILD === '1' ? start : `npm run build && ${start}`,
    url: `http://127.0.0.1:${APP_PORT}/api/check-env`,
    reuseExistingServer: false,
    timeout: 600_000,
    stdout: 'ignore',
    stderr: 'pipe',
    // Merged over the runner's environment, so anything that could reach a
    // real service is overwritten here, not just left unset.
    env: {
      USE_AIMOCK: 'true',
      AIMOCK_URL: `http://127.0.0.1:${AIMOCK_PORT}`,
      OPENAI_BASE_URL: `http://127.0.0.1:${AIMOCK_PORT}/v1`,
      OPENAI_API_KEY: 'mock',
      FIRECRAWL_API_URL: `http://127.0.0.1:${FIRECRAWL_STUB_PORT}`,
      AI_GATEWAY_API_KEY: 'stub',
      FIRECRAWL_API_KEY: 'stub',
      TURSO_DATABASE_URL: 'file:./.mastra/e2e.db',
      TURSO_AUTH_TOKEN: '',
      DOLT_HOST: '',
      DOLT_DATABASE: '',
      UPSTASH_REDIS_REST_URL: '',
      MASTRA_TELEMETRY_DISABLED: '1',
      NEXT_TELEMETRY_DISABLED: '1',
    },
  },
});
