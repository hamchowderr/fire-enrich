/**
 * Firecrawl API stub for the browser tests.
 *
 * A plain HTTP server that answers the three v2 endpoints the search-strategy
 * tools call (`lib/mastra/tools/firecrawl.ts`) with the SDK recordings in
 * `tests/fixtures/firecrawl/`. The app reaches it through `FIRECRAWL_API_URL`,
 * which `firecrawlClient()` passes to the SDK as `apiUrl`; the tools
 * themselves have no test-only branch.
 *
 * The recordings are what the SDK *returns*; the SDK unwraps an HTTP envelope
 * first (`node_modules/firecrawl/dist/index.js`), so each one is wrapped here:
 *
 * | request          | response body                                  | SDK reads          |
 * | ---------------- | ---------------------------------------------- | ------------------ |
 * | POST /v2/search  | `{ success: true, data: search.json }`         | `res.data.data`    |
 * | POST /v2/scrape  | `{ success: true, data: scrape.json }`         | `res.data.data`    |
 * | POST /v2/map     | `{ success: true, ...map.json }` (id, links)   | `res.data.links`   |
 *
 * Scrape answers only for the site the recording is of (firecrawl.dev); any
 * other url gets a 404 in the API's error shape, so a model that wanders off
 * the recorded pages reads nothing rather than a page it did not ask for.
 * Anything else (the hosted agent, crawl, batch) is a 404 too: the E2E plan
 * uses search groups only.
 *
 * Every request is appended to a log, one JSON line each, so a run can show
 * the tools actually came here.
 *
 * Run standalone: `node tests/e2e/firecrawl-stub.mjs [port] [logFile]`.
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const recordings = path.resolve(here, '../fixtures/firecrawl');

function recording(name) {
  return JSON.parse(readFileSync(path.join(recordings, `${name}.json`), 'utf8'));
}

function isRecordedSite(url) {
  try {
    return new URL(String(url)).hostname.replace(/^www\./, '') === 'firecrawl.dev';
  } catch {
    return false;
  }
}

function readBody(request) {
  return new Promise((resolve) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(text ? JSON.parse(text) : {});
      } catch {
        resolve({});
      }
    });
  });
}

/** The response for one request: `[status, body]`. */
function route(method, pathname, body) {
  if (method === 'GET' && pathname === '/health') return [200, { status: 'ok' }];

  if (method === 'POST' && pathname === '/v2/search') {
    return [200, { success: true, data: recording('search') }];
  }

  if (method === 'POST' && pathname === '/v2/scrape') {
    return isRecordedSite(body.url)
      ? [200, { success: true, data: recording('scrape') }]
      : [404, { success: false, error: `No recording for ${body.url}` }];
  }

  if (method === 'POST' && pathname === '/v2/map') {
    return [200, { success: true, ...recording('map') }];
  }

  return [404, { success: false, error: `The stub does not serve ${method} ${pathname}` }];
}

/**
 * Start the stub. Resolves once it is listening, to the `http.Server`.
 *
 * @param {{ port: number, host?: string, logFile?: string }} options
 */
export function startFirecrawlStub({ port, host = '127.0.0.1', logFile }) {
  if (logFile) mkdirSync(path.dirname(logFile), { recursive: true });

  const server = createServer(async (request, response) => {
    const { pathname } = new URL(request.url ?? '/', `http://${host}`);
    const body = request.method === 'POST' ? await readBody(request) : {};
    const [status, payload] = route(request.method, pathname, body);

    if (logFile && pathname !== '/health') {
      const entry = {
        at: new Date().toISOString(),
        method: request.method,
        path: pathname,
        status,
        ...(body.query ? { query: body.query } : {}),
        ...(body.url ? { url: body.url } : {}),
      };
      appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
    }

    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(payload));
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const port = Number(process.argv[2] ?? 4131);
  const logFile = process.argv[3] ? path.resolve(process.argv[3]) : undefined;
  await startFirecrawlStub({ port, logFile });
  console.log(`Firecrawl stub listening on http://127.0.0.1:${port}`);
}
