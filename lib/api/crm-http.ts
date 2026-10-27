/**
 * Shared answers for the FluentCRM routes (`app/api/crm/*`): one wording for
 * "not configured" and for a failed call, so the UI handles them the same way
 * whichever route it hit.
 */
import { NextResponse } from 'next/server';

export function crmNotConfigured(): NextResponse {
  return NextResponse.json(
    { error: 'FluentCRM is not configured: set FLUENTCRM_URL and FLUENTCRM_AUTH.' },
    { status: 503 }
  );
}

/** 502 with the client's message, which names the call and its status and never echoes a response body. */
export function crmFailed(error: unknown): NextResponse {
  return NextResponse.json({ error: error instanceof Error ? error.message : 'FluentCRM call failed' }, { status: 502 });
}
