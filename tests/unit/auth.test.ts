/**
 * Sign-in (`lib/auth`) and the middleware that requires it, end to end on the
 * test's libSQL file: a code is sent only to an allowed address, signing in
 * with it sets a session cookie, and the middleware lets that cookie through
 * and nothing else.
 */
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { POST } from '@/app/api/auth/[...all]/route';
import { allowedEmails, authDisabled, codeSender } from '@/lib/auth/config';
import { authSecret, setAuth } from '@/lib/auth';
import { middleware } from '@/middleware';

const ORIGIN = 'http://localhost:3000';
const OWNER = 'owner@example.com';

let sent: { email: string; code: string }[] = [];

function authPost(path: string, body: unknown) {
  return POST(
    new Request(`${ORIGIN}/api/auth${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify(body),
    })
  );
}

function through(path: string, cookie?: string) {
  return middleware(new NextRequest(`${ORIGIN}${path}`, { headers: { host: 'localhost:3000', ...(cookie ? { cookie } : {}) } }));
}

const passed = (res: Response) => res.headers.get('x-middleware-next') === '1';

async function signIn(email: string): Promise<string> {
  expect((await authPost('/email-otp/send-verification-otp', { email, type: 'sign-in' })).status).toBe(200);
  const code = sent.find((s) => s.email === email)?.code;
  expect(code).toMatch(/^\d{6}$/);
  const res = await authPost('/sign-in/email-otp', { email, otp: code });
  expect(res.status).toBe(200);
  const cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  expect(cookie).toContain('session_token');
  return cookie;
}

beforeEach(() => {
  sent = [];
  process.env.AUTH_ALLOWED_EMAILS = `${OWNER}, second@example.com`;
  delete process.env.AUTH_DISABLED;
  setAuth({ sendCode: async (email, code) => void sent.push({ email, code }) });
});

afterEach(() => {
  delete process.env.AUTH_ALLOWED_EMAILS;
  setAuth();
});

describe('auth config', () => {
  it('parses the allowlist, lowercased, comma or space separated', () => {
    expect([...allowedEmails({ AUTH_ALLOWED_EMAILS: ' A@x.com,b@y.com  c@z.com ' })]).toEqual([
      'a@x.com',
      'b@y.com',
      'c@z.com',
    ]);
    expect(allowedEmails({}).size).toBe(0);
  });

  it('honours AUTH_DISABLED off Vercel only', () => {
    expect(authDisabled({ AUTH_DISABLED: '1' })).toBe(true);
    expect(authDisabled({ AUTH_DISABLED: '1', VERCEL: '1' })).toBe(false);
    expect(authDisabled({})).toBe(false);
  });

  it('picks FluentCRM, then Resend, then the log off Vercel, and nothing on Vercel', () => {
    expect(codeSender({ FLUENTCRM_URL: 'https://crm', FLUENTCRM_AUTH: 'u:p', RESEND_API_KEY: 'k', AUTH_EMAIL_FROM: 'a@b' })).toBe('fluentcrm');
    expect(codeSender({ RESEND_API_KEY: 'k', AUTH_EMAIL_FROM: 'a@b' })).toBe('resend');
    expect(codeSender({})).toBe('log');
    expect(codeSender({ VERCEL: '1' })).toBeNull();
  });

  it('derives the secret from the Turso token, and refuses none on Vercel', () => {
    expect(authSecret({ BETTER_AUTH_SECRET: 'set' })).toBe('set');
    const derived = authSecret({ TURSO_AUTH_TOKEN: 'token' });
    expect(derived).toMatch(/^[0-9a-f]{64}$/);
    expect(derived).not.toContain('token');
    expect(() => authSecret({ VERCEL: '1' })).toThrow(/BETTER_AUTH_SECRET/);
  });
});

describe('sign-in and the middleware', () => {
  it('blocks every page and API route without a session', async () => {
    const api = await through('/api/enrich');
    expect(api.status).toBe(401);
    const page = await through('/');
    expect(page.status).toBe(307);
    expect(page.headers.get('location')).toBe(`${ORIGIN}/sign-in`);
    expect((await through('/api/profiles/abc')).headers.get('location')).toBeNull();
    expect(new URL((await through('/runs')).headers.get('location')!).searchParams.get('next')).toBe('/runs');
  });

  it('leaves the sign-in page and the auth endpoints open', async () => {
    expect(passed(await through('/sign-in'))).toBe(true);
    expect(passed(await through('/api/auth/get-session'))).toBe(true);
  });

  it('sends a code only to an allowed address, answering the same either way', async () => {
    const other = await authPost('/email-otp/send-verification-otp', { email: 'stranger@example.com', type: 'sign-in' });
    expect(other.status).toBe(200);
    expect(sent).toEqual([]);
    await authPost('/email-otp/send-verification-otp', { email: 'OWNER@example.com', type: 'sign-in' });
    expect(sent.map((s) => s.email.toLowerCase())).toEqual([OWNER]);
  });

  it('signs an allowed address in, and the middleware lets its session through', async () => {
    const cookie = await signIn(OWNER);
    expect(passed(await through('/', cookie))).toBe(true);
    expect(passed(await through('/api/enrich', cookie))).toBe(true);
    expect((await through('/api/enrich', 'better-auth.session_token=forged')).status).toBe(401);
  });

  it('rejects a wrong code', async () => {
    await authPost('/email-otp/send-verification-otp', { email: OWNER, type: 'sign-in' });
    const res = await authPost('/sign-in/email-otp', { email: OWNER, otp: sent[0].code === '000000' ? '111111' : '000000' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.headers.getSetCookie().join('')).not.toContain('session_token=');
  });

  it('shuts out a session at once when its address leaves the allowlist', async () => {
    const cookie = await signIn('second@example.com');
    process.env.AUTH_ALLOWED_EMAILS = OWNER;
    expect((await through('/api/enrich', cookie)).status).toBe(401);
  });

  it('lets everything through with AUTH_DISABLED off Vercel', async () => {
    process.env.AUTH_DISABLED = '1';
    try {
      expect(passed(await through('/api/enrich'))).toBe(true);
    } finally {
      delete process.env.AUTH_DISABLED;
    }
  });
});
