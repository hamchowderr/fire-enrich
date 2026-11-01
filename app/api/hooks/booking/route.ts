import { type NextRequest, NextResponse, after } from 'next/server';

import { crmNotConfigured } from '@/lib/api/crm-http';
import { BOOKING_FIELDS, hookSecretMatches, parseBooking, processBooking, type Research } from '@/lib/crm/booking';
import { fluentCrm } from '@/lib/crm/sync';
import { flushTracesAfter } from '@/lib/flush-traces';
import { enrichRowWithMastra, resolveSessionPlan } from '@/lib/mastra/enrich-adapter';

export const runtime = 'nodejs';
// The research runs after the response, inside this function's time.
export const maxDuration = 300;

/** One row through the same workflow the table uses, with the booking field set. */
const research: Research = async (email) => {
  const sessionId = `booking-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const { plan, fields } = await resolveSessionPlan(BOOKING_FIELDS);
  const result = await enrichRowWithMastra({
    sessionId,
    rowIndex: 0,
    row: { email },
    email,
    plan,
    fields,
    onProgress: () => {},
  });
  return result?.status === 'completed' ? result.enrichments : null;
};

/**
 * `POST /api/hooks/booking` ← the hub's FluentBooking webhook ("Booking
 * Confirmed"). Open to the internet past the sign-in (`middleware.ts`), so it
 * needs the shared secret `BOOKING_HOOK_SECRET` in an `x-hook-secret` header
 * (or `authorization: Bearer …`); without the variable set it refuses
 * everything. Answers 202 at once and researches after the response
 * (`lib/crm/booking.ts`).
 */
export async function POST(request: NextRequest) {
  const bearer = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!hookSecretMatches(request.headers.get('x-hook-secret') ?? bearer)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const crm = fluentCrm();
  if (!crm) return crmNotConfigured();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Send the booking as JSON' }, { status: 400 });
  }
  const booking = parseBooking(body);
  if (!booking) {
    const keys = body && typeof body === 'object' ? Object.keys(body).join(', ') : typeof body;
    console.warn(`[BOOKING] no email in webhook body (keys: ${keys})`);
    return NextResponse.json({ error: 'No booking email in the body' }, { status: 400 });
  }

  const done = processBooking(booking, crm, research).then(
    (outcome) => console.info(`[BOOKING] contact ${outcome.contactId}: ${outcome.status}, found ${outcome.found.length}`),
    (error) => console.error(`[BOOKING] failed: ${error instanceof Error ? error.message : String(error)}`)
  );
  flushTracesAfter(done);
  after(done);
  return NextResponse.json({ accepted: true }, { status: 202 });
}
