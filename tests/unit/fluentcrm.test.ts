import { afterEach, describe, expect, it, vi } from 'vitest';

import { sendSignInCode } from '@/lib/auth/email';

afterEach(() => {
  delete process.env.FLUENTCRM_URL;
  delete process.env.FLUENTCRM_AUTH;
});

describe('sign-in codes through FluentCRM', () => {
  it('finds the contact and sends the code with basic auth', async () => {
    process.env.FLUENTCRM_URL = 'https://crm.example.com/';
    process.env.FLUENTCRM_AUTH = 'user:app pass';
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const body = String(url).includes('/subscribers?search=')
        ? { subscribers: { data: [{ id: 7, email: 'Owner@Example.com' }] } }
        : { message: 'sent' };
      return new Response(JSON.stringify(body), { status: 200 });
    });

    await sendSignInCode('owner@example.com', '123456', fetchImpl as typeof fetch);

    expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
      'GET https://crm.example.com/wp-json/fluent-crm/v2/subscribers?search=owner%40example.com&per_page=10',
      'POST https://crm.example.com/wp-json/fluent-crm/v2/subscribers/7/emails/send',
    ]);
    const headers = calls[1].init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Basic ${Buffer.from('user:app pass').toString('base64')}`);
    const sent = JSON.parse(String(calls[1].init.body));
    expect(sent.campaign.email_subject).toContain('123456');
  });

  it('adds a missing contact as transactional before sending', async () => {
    process.env.FLUENTCRM_URL = 'https://crm.example.com';
    process.env.FLUENTCRM_AUTH = 'u:p';
    const bodies: unknown[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.body) bodies.push(JSON.parse(String(init.body)));
      if (String(url).includes('search=')) return new Response(JSON.stringify({ subscribers: { data: [] } }));
      if (String(url).endsWith('/subscribers')) return new Response(JSON.stringify({ contact: { id: 9 } }));
      return new Response('{}');
    });
    await sendSignInCode('new@example.com', '654321', fetchImpl as typeof fetch);
    expect(bodies[0]).toEqual({ email: 'new@example.com', status: 'transactional' });
    expect(fetchImpl.mock.calls.at(-1)?.[0]).toBe('https://crm.example.com/wp-json/fluent-crm/v2/subscribers/9/emails/send');
  });

  it('fails with the status only when FluentCRM refuses', async () => {
    process.env.FLUENTCRM_URL = 'https://crm.example.com';
    process.env.FLUENTCRM_AUTH = 'u:p';
    const fetchImpl = vi.fn(async () => new Response('secret echo', { status: 401 }));
    await expect(sendSignInCode('a@b.com', '1', fetchImpl as typeof fetch)).rejects.toThrow(
      'FluentCRM GET /subscribers answered 401'
    );
  });
});
