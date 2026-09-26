import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * API keys reach the routes from the environment only.
 *
 * Upstream fire-enrich lets the browser send `X-Firecrawl-API-Key` and
 * `X-OpenAI-API-Key` and falls back to them when the variables are unset. In
 * this deployment the keys are injected from the secrets manager at runtime
 * and must never travel from the client, so every route below is driven with
 * those headers set and checked both ways: with the variable unset the header
 * is ignored and the route answers its configuration error; with it set the
 * route proceeds and nothing from the headers reaches the work behind it.
 *
 * Handlers are called directly with a `NextRequest`. The Mastra layer behind
 * them (the enrich adapter, the chat agent) is mocked at the module boundary,
 * so nothing reaches Firecrawl or a model and the tests need neither AIMock nor
 * a network. The model and the Firecrawl tools read their keys from the
 * environment themselves; there is no key argument to check.
 *
 * The gateway's credential is either `AI_GATEWAY_API_KEY` or, on Vercel, the
 * deployment's OIDC token. Inside a Vercel function that token is not an
 * environment variable: it arrives on the request context that `@vercel/oidc`
 * reads from a well-known global, which the tests below install by hand.
 * `VERCEL_OIDC_TOKEN` is the local-development form (`vercel env pull`).
 */
const {
  resolveSessionPlanMock,
  startRunRecordingMock,
  enrichRowMock,
  chatStreamMock,
  firecrawlSdkCtor,
  scrapeMock,
} = vi.hoisted(() => ({
  resolveSessionPlanMock: vi.fn(),
  startRunRecordingMock: vi.fn(),
  enrichRowMock: vi.fn(),
  chatStreamMock: vi.fn(),
  firecrawlSdkCtor: vi.fn(),
  scrapeMock: vi.fn(),
}));

vi.mock('@/lib/mastra/enrich-adapter', () => ({
  resolveSessionPlan: resolveSessionPlanMock,
  startRunRecording: startRunRecordingMock,
  enrichRowWithMastra: enrichRowMock,
}));

vi.mock('@/lib/mastra', () => ({
  mastra: { getAgent: () => ({ stream: chatStreamMock }) },
}));

vi.mock('firecrawl', () => ({
  Firecrawl: class {
    constructor(...args: unknown[]) {
      firecrawlSdkCtor(...args);
    }
    scrape = scrapeMock;
    batchScrape = vi.fn();
  },
}));

// The scrape route consults Upstash-backed rate limiting; keep it out of the test.
vi.mock('@/lib/rate-limit', () => ({
  isRateLimited: async () => ({ success: true, limit: 50, remaining: 50 }),
}));

// Imported after the mocks are declared; `vi.mock` is hoisted above imports.
import { POST as enrich } from '@/app/api/enrich/route';
import { POST as chat } from '@/app/api/chat/route';
import { POST as scrape } from '@/app/api/scrape/route';
import { GET as checkEnv } from '@/app/api/check-env/route';

/**
 * What upstream's UI sends on every request, and a browser holding a key from
 * an older build still can; the routes must ignore it.
 */
const BROWSER_HEADERS = {
  'content-type': 'application/json',
  'X-Firecrawl-API-Key': 'fc-from-browser',
  'X-OpenAI-API-Key': 'sk-from-browser',
};

const ENRICH_BODY = {
  // Not on `app/fire-enrich/skip-list.txt`, so the row reaches the adapter.
  rows: [{ email: 'jane@firecrawl.dev' }],
  fields: [
    { name: 'company', displayName: 'Company', description: 'Company name', type: 'string', required: false },
  ],
  emailColumn: 'email',
};

const CHAT_BODY = {
  question: 'What does Firecrawl do?',
  context: { tableData: 'company,description\nFirecrawl,Web scraping API' },
  conversationHistory: [],
};

const SCRAPE_BODY = { url: 'https://firecrawl.dev' };

const ENV = [
  'FIRECRAWL_API_KEY',
  'AI_GATEWAY_API_KEY',
  'VERCEL_OIDC_TOKEN',
  'TURSO_DATABASE_URL',
  'FIRE_TURSO_DATABASE_URL',
  'FIRE_TURSO_AUTH_TOKEN',
  'DOLT_HOST',
  'DOLT_DATABASE',
  'DOLT_PASSWORD',
] as const;
const saved: Partial<Record<(typeof ENV)[number], string | undefined>> = {};

/** The global `@vercel/oidc` reads the request context from (see its `get-context.js`). */
const REQUEST_CONTEXT = Symbol.for('@vercel/request-context');
const OIDC_TOKEN = 'oidc-secret-value';

/** Installs a fake Vercel request context carrying only the OIDC token header. */
function installOidcRequestContext() {
  (globalThis as unknown as Record<symbol, unknown>)[REQUEST_CONTEXT] = {
    get: () => ({ headers: { 'x-vercel-oidc-token': OIDC_TOKEN } }),
  };
}

/** No gateway credential at all: no key, no local token, no request context. */
function clearGatewayCredentials() {
  delete process.env.AI_GATEWAY_API_KEY;
  delete process.env.VERCEL_OIDC_TOKEN;
  delete (globalThis as unknown as Record<symbol, unknown>)[REQUEST_CONTEXT];
}

function post(route: string, body: unknown) {
  return new NextRequest(`http://127.0.0.1${route}`, {
    method: 'POST',
    headers: BROWSER_HEADERS,
    body: JSON.stringify(body),
  });
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx|js|mjs)$/.test(entry.name) ? [full] : [];
  });
}

beforeEach(() => {
  for (const key of ENV) saved[key] = process.env[key];
  process.env.FIRECRAWL_API_KEY = 'fc-from-env';
  process.env.AI_GATEWAY_API_KEY = 'gw-from-env';
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  for (const key of ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  delete (globalThis as unknown as Record<symbol, unknown>)[REQUEST_CONTEXT];
  vi.restoreAllMocks();
  for (const mock of [resolveSessionPlanMock, startRunRecordingMock, enrichRowMock, chatStreamMock, firecrawlSdkCtor, scrapeMock]) {
    mock.mockReset();
  }
});

describe('POST /api/enrich', () => {
  it('answers the configuration error when FIRECRAWL_API_KEY is unset, whatever the headers carry', async () => {
    delete process.env.FIRECRAWL_API_KEY;

    const response = await enrich(post('/api/enrich', ENRICH_BODY));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Server configuration error: Missing API keys' });
    expect(resolveSessionPlanMock).not.toHaveBeenCalled();
    expect(enrichRowMock).not.toHaveBeenCalled();
  });

  it('answers the configuration error when neither AI_GATEWAY_API_KEY nor an OIDC token is present, whatever the headers carry', async () => {
    clearGatewayCredentials();

    const response = await enrich(post('/api/enrich', ENRICH_BODY));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Server configuration error: Missing API keys' });
    expect(resolveSessionPlanMock).not.toHaveBeenCalled();
    expect(enrichRowMock).not.toHaveBeenCalled();
  });

  it('passes the key gate with only the Vercel OIDC request context', async () => {
    clearGatewayCredentials();
    installOidcRequestContext();
    resolveSessionPlanMock.mockResolvedValue({ plan: { fields: [], groups: [] }, fields: ENRICH_BODY.fields });
    startRunRecordingMock.mockResolvedValue({ finish: vi.fn() });
    enrichRowMock.mockResolvedValue({
      rowIndex: 0,
      originalData: ENRICH_BODY.rows[0],
      enrichments: {},
      status: 'success',
    });

    const response = await enrich(post('/api/enrich', ENRICH_BODY));

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('"type":"complete"');
    expect(text).not.toContain(OIDC_TOKEN);
    expect(enrichRowMock).toHaveBeenCalledTimes(1);
  });

  it('proceeds with the environment keys and never the header values', async () => {
    resolveSessionPlanMock.mockResolvedValue({ plan: { fields: [], groups: [] }, fields: ENRICH_BODY.fields });
    startRunRecordingMock.mockResolvedValue({ finish: vi.fn() });
    enrichRowMock.mockResolvedValue({
      rowIndex: 0,
      originalData: ENRICH_BODY.rows[0],
      enrichments: {},
      status: 'success',
    });

    const response = await enrich(post('/api/enrich', ENRICH_BODY));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    // Drains the stream, so the handler runs to its `complete` event.
    expect(await response.text()).toContain('"type":"complete"');
    expect(resolveSessionPlanMock).toHaveBeenCalledTimes(1);
    expect(enrichRowMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(enrichRowMock.mock.calls[0][0])).not.toMatch(/from-browser/);
  });
});

describe('POST /api/chat', () => {
  it('answers the configuration error when FIRECRAWL_API_KEY is unset, whatever the headers carry', async () => {
    delete process.env.FIRECRAWL_API_KEY;

    const response = await chat(post('/api/chat', CHAT_BODY));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Missing API keys' });
    expect(chatStreamMock).not.toHaveBeenCalled();
  });

  it('answers the configuration error when neither AI_GATEWAY_API_KEY nor an OIDC token is present, whatever the headers carry', async () => {
    clearGatewayCredentials();

    const response = await chat(post('/api/chat', CHAT_BODY));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Missing API keys' });
    expect(chatStreamMock).not.toHaveBeenCalled();
  });

  it('passes the key gate with only the Vercel OIDC request context', async () => {
    clearGatewayCredentials();
    installOidcRequestContext();
    chatStreamMock.mockResolvedValue({
      fullStream: (async function* () {})(),
      steps: Promise.resolve([{ text: 'Firecrawl scrapes the web.' }]),
      text: Promise.resolve('Firecrawl scrapes the web.'),
    });

    const response = await chat(post('/api/chat', CHAT_BODY));

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('"type":"complete"');
    expect(text).not.toContain(OIDC_TOKEN);
    expect(chatStreamMock).toHaveBeenCalledTimes(1);
  });

  it('proceeds with the environment keys and never the header values', async () => {
    chatStreamMock.mockResolvedValue({
      fullStream: (async function* () {})(),
      steps: Promise.resolve([{ text: 'Firecrawl scrapes the web.' }]),
      text: Promise.resolve('Firecrawl scrapes the web.'),
    });

    const response = await chat(post('/api/chat', CHAT_BODY));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(await response.text()).toContain('"type":"complete"');
    expect(chatStreamMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(chatStreamMock.mock.calls[0])).not.toMatch(/from-browser/);
  });
});

describe('POST /api/scrape', () => {
  it('answers the configuration error when FIRECRAWL_API_KEY is unset, whatever the headers carry', async () => {
    delete process.env.FIRECRAWL_API_KEY;

    const response = await scrape(post('/api/scrape', SCRAPE_BODY));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      success: false,
      error: 'API configuration error. Please try again later or contact support.',
    });
    expect(firecrawlSdkCtor).not.toHaveBeenCalled();
  });

  it('proceeds with the environment key and never the header value', async () => {
    scrapeMock.mockResolvedValue({ markdown: '# Firecrawl' });

    const response = await scrape(post('/api/scrape', SCRAPE_BODY));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: { markdown: '# Firecrawl' } });
    expect(firecrawlSdkCtor).toHaveBeenCalledWith({ apiKey: 'fc-from-env' });
    expect(scrapeMock).toHaveBeenCalledWith('https://firecrawl.dev', {});
  });
});

describe('GET /api/check-env', () => {
  it('reports each variable as a boolean and never its value', async () => {
    process.env.FIRECRAWL_API_KEY = 'fc-secret-value';
    process.env.AI_GATEWAY_API_KEY = 'gw-secret-value';
    process.env.TURSO_DATABASE_URL = 'libsql://secret.turso.io';
    process.env.DOLT_HOST = 'dolt.internal';
    process.env.DOLT_DATABASE = 'fire_enrich_secret';

    const response = await checkEnv();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(Object.keys(body.environmentStatus).sort()).toEqual([
      'AI_GATEWAY_API_KEY',
      'FIRECRAWL_API_KEY',
      'TURSO_DATABASE_URL',
    ]);
    for (const value of Object.values(body.environmentStatus)) {
      expect(typeof value).toBe('boolean');
    }
    expect(body.environmentStatus).toEqual({
      FIRECRAWL_API_KEY: true,
      AI_GATEWAY_API_KEY: true,
      TURSO_DATABASE_URL: true,
    });
    expect(body.optional.dolt).toEqual({
      required: false,
      configured: true,
      misconfigured: false,
      missing: [],
      enables: ['versioned run history', 'run diffs'],
    });

    const text = JSON.stringify(body);
    for (const secret of ['fc-secret-value', 'gw-secret-value', 'secret.turso.io', 'dolt.internal', 'fire_enrich_secret']) {
      expect(text).not.toContain(secret);
    }
  });

  it('counts the VERCEL_OIDC_TOKEN variable (local development) as a configured gateway', async () => {
    for (const key of ENV) delete process.env[key];
    process.env.VERCEL_OIDC_TOKEN = OIDC_TOKEN;

    const body = await (await checkEnv()).json();

    expect(body.environmentStatus.AI_GATEWAY_API_KEY).toBe(true);
    expect(JSON.stringify(body)).not.toContain(OIDC_TOKEN);
  });

  it('counts the Vercel OIDC request context (deployed function) as a configured gateway', async () => {
    for (const key of ENV) delete process.env[key];
    installOidcRequestContext();

    const body = await (await checkEnv()).json();

    expect(body.environmentStatus).toEqual({
      FIRECRAWL_API_KEY: false,
      AI_GATEWAY_API_KEY: true,
      TURSO_DATABASE_URL: false,
    });
    expect(JSON.stringify(body)).not.toContain(OIDC_TOKEN);
  });

  it('reports false for every unset variable', async () => {
    for (const key of ENV) delete process.env[key];

    const body = await (await checkEnv()).json();

    expect(body.environmentStatus).toEqual({
      FIRECRAWL_API_KEY: false,
      AI_GATEWAY_API_KEY: false,
      TURSO_DATABASE_URL: false,
    });
  });

  it('counts the Turso pair the Marketplace integration sets under a custom prefix, and reports half of it as misconfigured', async () => {
    for (const key of ENV) delete process.env[key];
    process.env.FIRE_TURSO_DATABASE_URL = 'libsql://prefixed-secret.turso.io';

    const half = await (await checkEnv()).json();
    expect(half.environmentStatus.TURSO_DATABASE_URL).toBe(false);
    expect(half.turso).toEqual({
      configured: false,
      misconfigured: true,
      set: ['FIRE_TURSO_DATABASE_URL'],
      missing: ['FIRE_TURSO_AUTH_TOKEN'],
    });
    expect(JSON.stringify(half)).not.toContain('prefixed-secret.turso.io');

    process.env.FIRE_TURSO_AUTH_TOKEN = 'prefixed-secret-token';
    const body = await (await checkEnv()).json();

    expect(body.environmentStatus.TURSO_DATABASE_URL).toBe(true);
    expect(body.turso).toEqual({ configured: true, misconfigured: false, set: [], missing: [] });
    const text = JSON.stringify(body);
    for (const secret of ['prefixed-secret.turso.io', 'prefixed-secret-token']) expect(text).not.toContain(secret);
  });

  it('reports Dolt as optional and not configured, outside the required settings', async () => {
    for (const key of ENV) delete process.env[key];

    const body = await (await checkEnv()).json();

    expect(body.environmentStatus).not.toHaveProperty('DOLT_HOST');
    expect(body.optional.dolt).toEqual({
      required: false,
      configured: false,
      misconfigured: false,
      missing: [],
      enables: ['versioned run history', 'run diffs'],
    });
  });

  it('reports a partial Dolt as misconfigured, naming the missing variables and no values', async () => {
    for (const key of ENV) delete process.env[key];
    process.env.DOLT_HOST = 'dolt.internal';
    process.env.DOLT_PASSWORD = 'dolt-secret-password';

    const body = await (await checkEnv()).json();

    expect(body.optional.dolt).toMatchObject({ configured: false, misconfigured: true, missing: ['DOLT_DATABASE'] });
    expect(JSON.stringify(body)).not.toMatch(/dolt\.internal|dolt-secret-password/);
  });

  it('counts a whitespace-only DOLT_DATABASE as missing', async () => {
    for (const key of ENV) delete process.env[key];
    process.env.DOLT_HOST = 'dolt.internal';
    process.env.DOLT_DATABASE = '   ';

    const body = await (await checkEnv()).json();

    expect(body.optional.dolt).toMatchObject({ configured: false, misconfigured: true, missing: ['DOLT_DATABASE'] });
  });
});

describe('app/api source', () => {
  it('reads no API key from a request header', () => {
    const apiDir = fileURLToPath(new URL('../../app/api', import.meta.url));
    const files = sourceFiles(apiDir);
    expect(files.length).toBeGreaterThan(0);

    // Any mention of the header name counts, so a fallback cannot creep back
    // in under a different variable name or behind a comment.
    const offenders = files
      .filter((file) => /x-[\w-]*api-key/i.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(apiDir, file));

    expect(offenders).toEqual([]);
  });
});

describe('app source', () => {
  it('asks for no OpenAI key: the gateway is reported and configured under its own name', () => {
    const appDir = fileURLToPath(new URL('../../app', import.meta.url));
    const files = sourceFiles(appDir);
    expect(files.length).toBeGreaterThan(0);

    // The status field, the browser storage key and the request header the
    // upstream UI used for a model key the server never reads.
    const offenders = files
      .filter((file) => /OPENAI_API_KEY|openai_api_key|x-openai-api-key/i.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(appDir, file));
    expect(offenders).toEqual([]);

    // Both upload pages gate on the gateway's status.
    for (const page of ['page.tsx', 'fire-enrich/page.tsx']) {
      expect(readFileSync(path.join(appDir, page), 'utf8')).toContain('environmentStatus.AI_GATEWAY_API_KEY');
    }
  });
});
