import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Mirrors the `@/*` path alias in tsconfig.json.
    alias: { '@': fileURLToPath(new URL('.', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Most tests here touch the disk: they create SQLite files, re-import the
    // Mastra modules, or start node scripts. On a quiet machine the slowest
    // take 2 to 4 s. With two full suites running at once while Windows Defender
    // scanned the disk, single tests took up to 22 s and hooks over 10 s,
    // past Vitest's 5 s and 10 s defaults. 30 s leaves room for that and
    // still fails a hung test well inside any CI step limit.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    globalSetup: ['tests/global-setup.ts'],
    setupFiles: ['tests/setup.ts'],
  },
});
