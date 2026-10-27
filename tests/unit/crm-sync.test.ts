/**
 * The FluentCRM pull and push (`lib/crm/sync.ts`) against a fake FluentCRM
 * REST API: contacts become rows, enriched fields map to custom fields, and
 * the push sends only changed values, never clears one and never adds a
 * contact.
 */
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GET as getContacts } from '@/app/api/crm/contacts/route';
import { POST as push } from '@/app/api/crm/push/route';
import { FluentCrm } from '@/lib/crm/fluentcrm';
import { contactRows, crmValue, mapFields, pushToCrm } from '@/lib/crm/sync';

const BASE = 'https://crm.example.com/wp-json/fluent-crm/v2';

const FIELDS = [
  { name: 'industry', displayName: 'Industry' },
  { name: 'employee_count', displayName: 'Employee Count' },
  { name: 'tech_stack', displayName: 'Tech Stack' },
];

type Handler = (method: string, path: string, body: unknown) => unknown;

function fakeCrm(handler: Handler) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).slice(BASE.length);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });
    const answer = handler(method, path, body);
    if (answer instanceof Response) return answer;
    return new Response(JSON.stringify(answer ?? {}), { status: 200 });
  });
  return { crm: new FluentCrm('https://crm.example.com', 'u:p', fetchImpl as typeof fetch), calls };
}

const contact = (id: number, email: string, custom: Record<string, string> | [] = []) => ({
  id,
  email,
  first_name: 'Ada',
  last_name: null,
  company: { name: 'Acme' },
  custom_fields: custom,
});

afterEach(() => {
  delete process.env.FLUENTCRM_URL;
  delete process.env.FLUENTCRM_AUTH;
});

describe('pull', () => {
  it('turns contacts into rows, email first, dropping empty columns', () => {
    const { rows, columns } = contactRows([contact(1, 'a@x.com'), { ...contact(2, 'b@x.com'), company: null }]);
    expect(columns).toEqual(['email', 'first_name', 'company']);
    expect(rows).toEqual([
      { email: 'a@x.com', first_name: 'Ada', company: 'Acme' },
      { email: 'b@x.com', first_name: 'Ada', company: '' },
    ]);
  });

  it('pages through a tag up to the limit', async () => {
    const { crm, calls } = fakeCrm((_m, path) => {
      const page = Number(new URLSearchParams(path.split('?')[1]).get('page'));
      const data = Array.from({ length: 100 }, (_, i) => contact(page * 1000 + i, `c${page}-${i}@x.com`));
      return { subscribers: { data, total: 250, last_page: 3 } };
    });
    const { contacts, total } = await crm.contacts({ tag: 7, limit: 150 });
    expect(total).toBe(250);
    expect(contacts).toHaveLength(150);
    expect(calls.map((c) => c.path)).toEqual([
      '/subscribers?per_page=100&page=1&custom_fields=true&tags%5B%5D=7',
      '/subscribers?per_page=100&page=2&custom_fields=true&tags%5B%5D=7',
    ]);
  });

  it('serves rows from the contacts route, and 503 without FluentCRM', async () => {
    const req = (q: string) => new NextRequest(`http://localhost:3000/api/crm/contacts${q}`);
    expect((await getContacts(req(''))).status).toBe(503);

    process.env.FLUENTCRM_URL = 'https://crm.example.com';
    process.env.FLUENTCRM_AUTH = 'u:p';
    expect((await getContacts(req('?limit=5000'))).status).toBe(400);
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ subscribers: { data: [contact(1, 'a@x.com')], total: 1, last_page: 1 } }))
    );
    try {
      const res = await getContacts(req('?list=2&tag='));
      expect(await res.json()).toMatchObject({ rows: [{ email: 'a@x.com' }], total: 1 });
      expect(String(spy.mock.calls[0][0])).toContain('lists%5B%5D=2');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('field mapping and values', () => {
  it('matches by enrich_ slug, then by slug, then by label, and names what to create', () => {
    const mapping = mapFields(FIELDS, [
      { slug: 'enrich_industry', label: 'Sector', type: 'text' },
      { slug: 'other', label: 'employee count', type: 'text' },
    ]);
    expect(mapping.mapped).toEqual([
      { field: 'industry', slug: 'enrich_industry', label: 'Sector' },
      { field: 'employee_count', slug: 'other', label: 'employee count' },
    ]);
    expect(mapping.unmatched).toEqual([{ field: 'tech_stack', slug: 'enrich_tech_stack', label: 'Enrich: Tech Stack' }]);
  });

  it('formats values, and gives nothing for an unknown one', () => {
    expect(crmValue(['React', ' Go ', ''])).toBe('React, Go');
    expect(crmValue(true)).toBe('Yes');
    expect(crmValue(42)).toBe('42');
    expect(crmValue(null)).toBeUndefined();
    expect(crmValue('  ')).toBeUndefined();
    expect(crmValue([])).toBeUndefined();
  });
});

describe('push', () => {
  const definitions = {
    fields: [
      { slug: 'enrich_industry', label: 'Enrich: Industry', type: 'text' },
      { slug: 'enrich_employee_count', label: 'Enrich: Employee Count', type: 'text' },
    ],
  };

  function crmWith(contacts: ReturnType<typeof contact>[]) {
    return fakeCrm((method, path) => {
      if (path === '/custom-fields/contacts') return definitions;
      if (method === 'GET' && path.startsWith('/subscribers?search=')) {
        const email = decodeURIComponent(path.split('search=')[1].split('&')[0]);
        return { subscribers: { data: contacts.filter((c) => c.email === email) } };
      }
      if (method === 'PUT') return { message: 'The contact has been updated.' };
      return new Response('{}', { status: 404 });
    });
  }

  it('sends only changed values, never clears one, and skips emails with no contact', async () => {
    const { crm, calls } = crmWith([
      contact(1, 'changed@x.com', { enrich_industry: 'Retail', enrich_employee_count: '50' }),
      contact(2, 'same@x.com', { enrich_industry: 'SaaS' }),
    ]);
    const summary = await pushToCrm(crm, FIELDS, [
      { email: 'changed@x.com', values: { industry: 'SaaS', employee_count: null, tech_stack: ['React'] } },
      { email: 'same@x.com', values: { industry: 'SaaS' } },
      { email: 'missing@x.com', values: { industry: 'SaaS' } },
    ]);
    expect(summary.updated).toEqual(['changed@x.com']);
    expect(summary.unchanged).toEqual(['same@x.com']);
    expect(summary.notInCrm).toEqual(['missing@x.com']);
    expect(summary.mapping.unmatched.map((u) => u.field)).toEqual(['tech_stack']);
    const writes = calls.filter((c) => c.method !== 'GET');
    expect(writes).toEqual([{ method: 'PUT', path: '/subscribers/1', body: { custom_values: { enrich_industry: 'SaaS' } } }]);
  });

  it('writes nothing on a dry run', async () => {
    const { crm, calls } = crmWith([contact(1, 'a@x.com')]);
    const summary = await pushToCrm(crm, FIELDS, [{ email: 'a@x.com', values: { industry: 'SaaS' } }], { dryRun: true });
    expect(summary.mapping.mapped).toHaveLength(2);
    expect(calls.map((c) => c.path)).toEqual(['/custom-fields/contacts']);
  });

  it('records a failed contact and carries on', async () => {
    const { crm } = fakeCrm((method, path) => {
      if (path === '/custom-fields/contacts') return definitions;
      if (path.includes('bad%40x.com')) return new Response('nope', { status: 500 });
      if (method === 'GET') return { subscribers: { data: [contact(3, 'ok@x.com')] } };
      return {};
    });
    const summary = await pushToCrm(crm, FIELDS, [
      { email: 'bad@x.com', values: { industry: 'SaaS' } },
      { email: 'ok@x.com', values: { industry: 'SaaS' } },
    ]);
    expect(summary.failed).toEqual([{ email: 'bad@x.com', error: 'FluentCRM GET /subscribers answered 500' }]);
    expect(summary.updated).toEqual(['ok@x.com']);
  });

  it('validates the push body', async () => {
    process.env.FLUENTCRM_URL = 'https://crm.example.com';
    process.env.FLUENTCRM_AUTH = 'u:p';
    const res = await push(
      new NextRequest('http://localhost:3000/api/crm/push', {
        method: 'POST',
        body: JSON.stringify({ fields: [], rows: [{ email: 'not-an-email', values: {} }] }),
      })
    );
    expect(res.status).toBe(400);
  });
});
