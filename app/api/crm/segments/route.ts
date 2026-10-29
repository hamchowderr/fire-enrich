import { NextResponse } from 'next/server';

import { crmFailed, crmNotConfigured } from '@/lib/api/crm-http';
import { fluentCrm } from '@/lib/crm/sync';

/** `GET /api/crm/segments` → the FluentCRM lists and tags contacts can be pulled by. */
export async function GET() {
  const crm = fluentCrm();
  if (!crm) return crmNotConfigured();
  try {
    return NextResponse.json(await crm.segments());
  } catch (error) {
    return crmFailed(error);
  }
}
