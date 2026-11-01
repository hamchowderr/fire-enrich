/**
 * Pre-call research for a booking (`lib/crm/booking.ts`) and its webhook
 * (`POST /api/hooks/booking`), against a fake FluentCRM REST API and a fake
 * research function: the contact is found or added, findings land in custom
 * fields and a note, a personal email is not researched, and the hook needs
 * its shared secret.
 */
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/mastra/enrich-adapter', () => ({
  resolveSessionPlan: vi.fn(async (fields: unknown[]) => ({ plan: {}, fields, planId: null })),
  enrichRowWithMastra: vi.fn(async () => ({
    rowIndex: 0,
    originalData: {},
    status: 'completed',
    enrichments: { industry: { field: 'industry', value: 'Consulting', confidence: 0.9, source: 'https://acme.test/about' } },
  })),
}));

import { POST } from '@/app/api/hooks/booking/route';
import { BOOKING_FIELDS, briefHtml, hookSecretMatches, parseBooking, processBooking } from '@/lib/crm/booking';
import { FluentCrm } from '@/lib/crm/fluentcrm';
import type { EnrichmentResult } from '@/lib/types';

import { watchTraceFlush } from '../trace-flush';

const BASE = 'https://crm.example.com/wp-json/fluent-crm/v2';

function fakeCrm(existing: { id: number; email: string }[] = []) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  let fields: { slug: string; label: string; type: string }[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).slice(BASE.length);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });
    let answer: unknown = {};
    if (method === 'GET' && path.startsWith('/subscribers?')) {
      answer = { subscribers: { data: existing.map((c) => ({ ...c, custom_fields: [] })) } };
    } else if (method === 'POST' && path === '/subscribers') {
      answer = { contact: { id: 99 } };
    } else if (path === '/custom-fields/contacts') {
      if (method === 'PUT') fields = (body as { fields: typeof fields }).fields;
      answer = { fields };
    }
    return new Response(JSON.stringify(answer), { status: 200 });
  });
  return { crm: new FluentCrm('https://crm.example.com', 'u:p', fetchImpl as typeof fetch), calls, fetchImpl };
}

const BOOKING_BODY = {
  first_name: 'Dan',
  last_name: 'Condell',
  email: 'Dan@Acme.test',
  message: 'Whole projects, not one-off tasks.',
  start_time: '2026-11-09 17:00:00',
  title: '<strong>Free call</strong> meeting',
  custom_form_data: {
    company: { label: 'Company', type: 'text', value: 'Acme' },
    call_outcome: { label: 'What would make this call worth your time?', type: 'textarea', value: '' },
  },
};

const finding = (field: string, value: EnrichmentResult['value'], source?: string): EnrichmentResult => ({
  field,
  value,
  confidence: 0.9,
  source,
});

afterEach(() => {
  delete process.env.BOOKING_HOOK_SECRET;
  delete process.env.FLUENTCRM_URL;
  delete process.env.FLUENTCRM_AUTH;
});

describe('parseBooking', () => {
  it('reads a FluentBooking booking with its form answers, dropping empty ones', () => {
    expect(parseBooking(BOOKING_BODY)).toEqual({
      email: 'dan@acme.test',
      name: 'Dan Condell',
      event: 'Free call meeting',
      startTime: '2026-11-09 17:00:00',
      message: 'Whole projects, not one-off tasks.',
      answers: [['Company', 'Acme']],
    });
  });

  it('reads the guest and booking when nested', () => {
    const b = parseBooking({ guest: { email: 'a@b.co', full_name: 'Ada Lovelace' }, booking: { event_name: 'Partnerships' } });
    expect(b).toMatchObject({ email: 'a@b.co', name: 'Ada Lovelace', event: 'Partnerships', answers: [] });
  });

  it('is null without a usable email', () => {
    expect(parseBooking({ first_name: 'x' })).toBeNull();
    expect(parseBooking({ email: 'not-an-email' })).toBeNull();
    expect(parseBooking('x')).toBeNull();
  });
});

describe('hookSecretMatches', () => {
  it('needs the configured secret, and refuses everything without one', () => {
    expect(hookSecretMatches('s3cret', 's3cret')).toBe(true);
    expect(hookSecretMatches('wrong!', 's3cret')).toBe(false);
    expect(hookSecretMatches(null, 's3cret')).toBe(false);
    expect(hookSecretMatches('anything', undefined)).toBe(false);
    expect(hookSecretMatches('', '')).toBe(false);
  });
});

describe('briefHtml', () => {
  it('lists findings with sources, what was not found, and escapes everything', () => {
    const html = briefHtml({ ...parseBooking(BOOKING_BODY)!, message: '<script>x</script>' }, {
      industry: finding('industry', 'Consulting', 'https://acme.test/about'),
      services: finding('services', ['Builds', 'Audits']),
    });
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('<li>Industry: Consulting (<a href="https://acme.test/about">source</a>)</li>');
    expect(html).toContain('<li>Services: Builds, Audits</li>');
    expect(html).toMatch(/Not found:<\/strong> Company, Website/);
  });
});

describe('processBooking', () => {
  it('adds a missing contact, writes found fields and a note', async () => {
    const { crm, calls } = fakeCrm();
    const research = vi.fn(async () => ({ industry: finding('industry', 'Consulting') }));
    const outcome = await processBooking(parseBooking(BOOKING_BODY)!, crm, research);

    expect(research).toHaveBeenCalledWith('dan@acme.test');
    expect(outcome).toMatchObject({ contactId: 99, status: 'researched', found: ['industry'] });
    expect(calls).toContainEqual({ method: 'POST', path: '/subscribers', body: { email: 'dan@acme.test', status: 'transactional' } });
    const fieldsPut = calls.find((c) => c.method === 'PUT' && c.path === '/custom-fields/contacts');
    expect((fieldsPut!.body as { fields: unknown[] }).fields).toHaveLength(BOOKING_FIELDS.length);
    const note = calls.find((c) => c.path === '/subscribers/99/notes');
    expect(note!.body).toMatchObject({ note: { title: 'Pre-call brief: Dan Condell', type: 'note' } });
  });

  it('notes a personal email instead of researching it', async () => {
    const { crm, calls } = fakeCrm([{ id: 7, email: 'dan@gmail.com' }]);
    const research = vi.fn();
    const outcome = await processBooking(parseBooking({ ...BOOKING_BODY, email: 'dan@gmail.com' })!, crm, research);
    expect(research).not.toHaveBeenCalled();
    expect(outcome.status).toBe('skipped');
    const note = calls.find((c) => c.path === '/subscribers/7/notes');
    expect(JSON.stringify(note!.body)).toContain('Not researched');
  });

  it('still leaves a note when research fails', async () => {
    const { crm, calls } = fakeCrm([{ id: 7, email: 'dan@acme.test' }]);
    const outcome = await processBooking(parseBooking(BOOKING_BODY)!, crm, async () => {
      throw new Error('boom');
    });
    expect(outcome.status).toBe('failed');
    expect(calls.some((c) => c.path === '/custom-fields/contacts')).toBe(false);
    expect(JSON.stringify(calls.find((c) => c.path === '/subscribers/7/notes')!.body)).toContain('Research failed');
  });
});

describe('POST /api/hooks/booking', () => {
  const hook = (body: unknown, headers: Record<string, string> = {}) =>
    POST(
      new NextRequest('http://localhost:3000/api/hooks/booking', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      })
    );

  it('refuses without the secret, and when none is configured', async () => {
    expect((await hook(BOOKING_BODY, { 'x-hook-secret': 'anything' })).status).toBe(401);
    process.env.BOOKING_HOOK_SECRET = 's3cret';
    expect((await hook(BOOKING_BODY)).status).toBe(401);
    expect((await hook(BOOKING_BODY, { 'x-hook-secret': 'wrong' })).status).toBe(401);
  });

  it('answers 400 without an email, and 202 with one, researching after the response', async () => {
    process.env.BOOKING_HOOK_SECRET = 's3cret';
    process.env.FLUENTCRM_URL = 'https://crm.example.com';
    process.env.FLUENTCRM_AUTH = 'u:p';
    expect((await hook({ first_name: 'x' }, { authorization: 'Bearer s3cret' })).status).toBe(400);

    const { calls, fetchImpl } = fakeCrm();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(fetchImpl as typeof fetch);
    try {
      const runAfter = watchTraceFlush();
      const res = await hook(BOOKING_BODY, { 'x-hook-secret': 's3cret' });
      expect(res.status).toBe(202);
      await runAfter();
      expect(calls.some((c) => c.path === '/subscribers/99/notes')).toBe(true);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
