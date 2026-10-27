import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { crmFailed, crmNotConfigured } from '@/lib/api/crm-http';
import { contactRows, fluentCrm } from '@/lib/crm/sync';

const querySchema = z.object({
  list: z.coerce.number().int().positive().optional(),
  tag: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
});

/**
 * `GET /api/crm/contacts?list=&tag=&limit=` → contacts as table rows, the
 * shape a CSV upload gives, plus how many match in all.
 */
export async function GET(request: NextRequest) {
  const crm = fluentCrm();
  if (!crm) return crmNotConfigured();
  const params = Object.fromEntries(
    [...request.nextUrl.searchParams].filter(([, value]) => value !== '')
  );
  const parsed = querySchema.safeParse(params);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid query', issues: parsed.error.issues }, { status: 400 });
  }
  try {
    const { list, tag, limit } = parsed.data;
    const { contacts, total } = await crm.contacts({ list, tag, limit: limit ?? 500 });
    return NextResponse.json({ ...contactRows(contacts), total });
  } catch (error) {
    return crmFailed(error);
  }
}
