/**
 * Vitest setup, loaded before every test file (see `vitest.config.mts`).
 *
 * Pins the environment so a test can never reach a real model, Firecrawl, or
 * Turso: the model path is forced onto AIMock, the provider keys are stubs
 * that would be rejected by the real services, and Mastra's storage is a
 * throwaway SQLite file in the OS temp directory (one per worker process, so
 * parallel workers never contend for the same write lock).
 *
 * `AIMOCK_URL` is left alone when already set, so CI can point at its own
 * mock server; everything else is overwritten on purpose.
 */
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { vi } from 'vitest';

// Tests call route handlers directly, outside a Next.js request scope, where
// `after` throws. Record the tasks instead, so a test can inspect them.
vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  after: vi.fn(),
}));

process.env.USE_AIMOCK = 'true';
process.env.AIMOCK_URL ??= 'http://127.0.0.1:4010';

process.env.AI_GATEWAY_API_KEY = 'stub';
process.env.FIRECRAWL_API_KEY = 'stub';
process.env.MASTRA_TELEMETRY_DISABLED = '1';

const storageDir = path.join(os.tmpdir(), 'fire-enrich-tests');
mkdirSync(storageDir, { recursive: true });
process.env.TURSO_DATABASE_URL = `file:${path.join(storageDir, `test-${process.pid}.db`)}`;
delete process.env.TURSO_AUTH_TOKEN;
