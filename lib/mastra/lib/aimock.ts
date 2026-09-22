/**
 * AIMock switch for the Mastra layer.
 *
 * AIMock (`@copilotkit/aimock`) is an OpenAI-compatible mock server driven by
 * the fixtures under `fixtures/`. With `USE_AIMOCK=true` every model call is
 * served from those fixtures, so tests run with no provider key and no network.
 *
 * Three environment variables control it, all read directly from
 * `process.env` because this app has no env module:
 *
 * - `USE_AIMOCK`   — `"true"` turns the switch on; anything else leaves the
 *                    Vercel AI Gateway path untouched.
 * - `AIMOCK_URL`   — where the mock server listens (default
 *                    `http://127.0.0.1:4010`, the `npm run aimock` port).
 * - `AIMOCK_MODEL` — the model id sent to the mock server (default
 *                    `gpt-4o-mini`). Fixtures can match on it.
 */

const DEFAULT_AIMOCK_URL = 'http://127.0.0.1:4010';

export function isAIMockEnabled(): boolean {
  return process.env.USE_AIMOCK === 'true';
}

/** Mock server origin with no trailing slash, so `${url}/v1` is always well formed. */
export function aimockBaseUrl(): string {
  return (process.env.AIMOCK_URL ?? DEFAULT_AIMOCK_URL).replace(/\/$/, '');
}

/**
 * Point any OpenAI-compatible client that reads its base URL from the
 * environment at AIMock.
 *
 * MUST run before such a client is constructed: the Vercel AI SDK reads
 * `OPENAI_BASE_URL` when a provider instance is created and caches it, so a
 * late override silently hits the real API. `lib/mastra/index.ts` calls this
 * before building the Mastra instance. `resolveModel()` in `lib/mastra/models.ts`
 * does not depend on it — it passes the AIMock URL to `createOpenAI` explicitly —
 * so an agent module evaluated before this call still lands on the mock.
 *
 * No-op unless `USE_AIMOCK=true`. Idempotent.
 */
export function configureAIMock(): void {
  if (!isAIMockEnabled()) return;

  process.env.OPENAI_BASE_URL = `${aimockBaseUrl()}/v1`;
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? 'mock';
}
