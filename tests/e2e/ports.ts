/** Ports and log paths shared by the Playwright config, its global setup and the spec. */
import path from 'node:path';

export const AIMOCK_PORT = 4031;
export const FIRECRAWL_STUB_PORT = 4131;
export const APP_PORT = 3601;

/** Where the mocks write their logs and pids (gitignored). */
export const LOG_DIR = path.resolve('tests/e2e/.logs');
export const FIRECRAWL_STUB_LOG = path.join(LOG_DIR, 'firecrawl-stub.log');
export const AIMOCK_LOG = path.join(LOG_DIR, 'aimock.log');
export const PIDS_FILE = path.join(LOG_DIR, 'pids.json');
