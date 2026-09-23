/**
 * Start the two mocks the browser test runs against, as child processes:
 *
 * - AIMock (`llmock -p 4031 -f ./fixtures --validate-on-load --strict`), the
 *   same CLI and flags as `npm run aimock`, on its own port;
 * - the Firecrawl stub (`tests/e2e/firecrawl-stub.mjs`) on 4131.
 *
 * Their pids go to `tests/e2e/.logs/pids.json` for `global-teardown.ts`. A
 * port already in use fails the run instead of reusing whatever holds it: a
 * stray server from another run would answer with fixtures this run did not
 * load.
 */
import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import {
  AIMOCK_LOG,
  AIMOCK_PORT,
  FIRECRAWL_STUB_LOG,
  FIRECRAWL_STUB_PORT,
  LOG_DIR,
  PIDS_FILE,
} from './ports';

function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

async function waitForHealth(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${url} did not become healthy within ${timeoutMs}ms`);
}

function startProcess(args: string[], logFile: string): number {
  const log = createWriteStream(logFile);
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  if (!child.pid) throw new Error(`Could not start ${args.join(' ')}`);
  return child.pid;
}

export default async function globalSetup(): Promise<void> {
  for (const port of [AIMOCK_PORT, FIRECRAWL_STUB_PORT]) {
    if (await portInUse(port)) throw new Error(`Port ${port} is already in use; stop whatever holds it and rerun.`);
  }

  rmSync(LOG_DIR, { recursive: true, force: true });
  mkdirSync(LOG_DIR, { recursive: true });

  const aimockCli = path.resolve('node_modules/@copilotkit/aimock/dist/cli.js');
  const pids = [
    startProcess(
      [aimockCli, '-p', String(AIMOCK_PORT), '-h', '127.0.0.1', '-f', './fixtures', '--validate-on-load', '--strict'],
      AIMOCK_LOG
    ),
    startProcess(
      [path.resolve('tests/e2e/firecrawl-stub.mjs'), String(FIRECRAWL_STUB_PORT), FIRECRAWL_STUB_LOG],
      path.join(LOG_DIR, 'firecrawl-stub.out.log')
    ),
  ];
  writeFileSync(PIDS_FILE, JSON.stringify(pids));

  try {
    await waitForHealth(`http://127.0.0.1:${AIMOCK_PORT}/health`);
    await waitForHealth(`http://127.0.0.1:${FIRECRAWL_STUB_PORT}/health`);
  } catch (error) {
    // Teardown may not run after a failed setup, so stop what was started here.
    for (const pid of pids) {
      try {
        process.kill(pid);
      } catch {
        // already gone
      }
    }
    throw error;
  }
}
