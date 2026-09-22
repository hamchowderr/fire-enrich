import { createServer, type IncomingMessage, type Server } from 'node:http';

import { NextRequest } from 'next/server';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { POST } from '@/app/api/mastra/smoke/route';

import smokeFixtures from '../../fixtures/smoke-echo.json';

/**
 * Drives the temporary smoke route through Mastra and AIMock.
 *
 * Supertest needs a `node:http` server, and a Next.js route handler takes a
 * `NextRequest`, so the server below translates each incoming request into a
 * `NextRequest`, calls the handler, and writes the `Response` back. Nothing
 * from Next's runtime is booted; only the handler module is imported.
 *
 * Requires the mock server from `npm run aimock` (or `npm run test:ai`, which
 * starts it) on `AIMOCK_URL`; `tests/setup.ts` forces the model path onto it.
 */
const AIMOCK_URL = process.env.AIMOCK_URL as string;
const ROUTE = '/api/mastra/smoke';
const [echo] = smokeFixtures.fixtures;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function toHeaders(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  return headers;
}

function routeServer(): Server {
  return createServer(async (req, res) => {
    const body = await readBody(req);
    const nextRequest = new NextRequest(new URL(req.url ?? '/', 'http://localhost'), {
      method: req.method,
      headers: toHeaders(req),
      body: body.length > 0 ? body : undefined,
    });

    const response = await POST(nextRequest);

    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(await response.text());
  });
}

let server: Server;

beforeAll(async () => {
  const health = await fetch(`${AIMOCK_URL}/health`).catch(() => undefined);
  if (!health?.ok) {
    throw new Error(
      `AIMock is not reachable at ${AIMOCK_URL}. Run \`npm run test:ai\`, or start \`npm run aimock\` in another terminal.`
    );
  }
  server = routeServer();
});

afterAll(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
});

describe(`POST ${ROUTE}`, () => {
  it('returns the fixture text through Mastra and AIMock', { timeout: 30_000 }, async () => {
    const response = await request(server)
      .post(ROUTE)
      .send({ message: echo.match.userMessage })
      .expect(200)
      .expect('Content-Type', /application\/json/);

    expect(response.body).toEqual({ text: echo.response.content });
  });

  it('rejects a body without a message', async () => {
    const response = await request(server).post(ROUTE).send({}).expect(400);

    expect(response.body.error).toMatch(/message/);
  });

  it('rejects a non-JSON body', async () => {
    const response = await request(server)
      .post(ROUTE)
      .set('Content-Type', 'text/plain')
      .send('not json')
      .expect(400);

    expect(response.body.error).toMatch(/JSON/);
  });
});
