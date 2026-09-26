/**
 * Vitest setup, loaded before every test file (see `vitest.config.mts`).
 *
 * Pins the environment so a test can never reach a real model, Firecrawl, or
 * Turso: the model path is forced onto AIMock, the provider keys are stubs
 * that would be rejected by the real services, and Mastra's storage is a
 * throwaway SQLite file in the run's temporary directory (one per worker
 * process, so parallel workers never contend for the same write lock;
 * `tests/global-setup.ts` removes the directory when the run ends).
 *
 * `AIMOCK_URL` is left alone when already set, so CI can point at its own
 * mock server; everything else is overwritten on purpose.
 */
import path from 'node:path';

import { inject, vi } from 'vitest';

// Tests call route handlers directly, outside a Next.js request scope, where
// `after` throws. Record the tasks instead, so a test can inspect them.
vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  after: vi.fn(),
}));

process.env.USE_AIMOCK = 'true';
process.env.AIMOCK_URL ??= 'http://127.0.0.1:4010';

// The opt-in live measurement of the evidence check
// (tests/evidence/evidence-support.live.test.ts, EVIDENCE_LIVE=1) passes the
// real gateway key to its own evaluation model under a separate name. The
// global key is still stubbed, so nothing else can reach the gateway.
if (process.env.EVIDENCE_LIVE === '1' && process.env.AI_GATEWAY_API_KEY) {
  process.env.EVIDENCE_LIVE_GATEWAY_KEY = process.env.AI_GATEWAY_API_KEY;
}
process.env.AI_GATEWAY_API_KEY = 'stub';
process.env.FIRECRAWL_API_KEY = 'stub';
process.env.MASTRA_TELEMETRY_DISABLED = '1';
// The evidence-support check is on by default and calls a real evaluation
// model; tests that need it on set it themselves
// (tests/workflows/evidence-check.test.ts).
process.env.EVIDENCE_CHECK = '0';

process.env.TURSO_DATABASE_URL = `file:${path.join(inject('tempDir'), `store-${process.pid}.db`)}`;
delete process.env.TURSO_AUTH_TOKEN;
