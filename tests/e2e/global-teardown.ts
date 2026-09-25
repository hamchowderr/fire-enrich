/** Stop the mocks `global-setup.ts` started, by the pids it recorded. */
import { existsSync, readFileSync, rmSync } from 'node:fs';

import { PIDS_FILE } from './ports';

export default async function globalTeardown(): Promise<void> {
  if (!existsSync(PIDS_FILE)) return;

  const pids = JSON.parse(readFileSync(PIDS_FILE, 'utf8')) as number[];
  for (const pid of pids) {
    try {
      process.kill(pid);
    } catch {
      // already gone
    }
  }
  rmSync(PIDS_FILE, { force: true });
}
