/**
 * Pre-call research for a booking: the hub's FluentBooking webhook
 * (`POST /api/hooks/booking`) hands over who booked, and this researches their
 * company and writes what it found back to their FluentCRM contact, as custom
 * fields (the push in `lib/crm/sync.ts`) and as one note with the brief.
 *
 * The contact is found by the booking email, or added as `transactional` (no
 * marketing opt-in) when there is none, because FluentBooking does not add
 * bookers to the CRM unless its own FluentCRM integration is set up.
 *
 * The form answers are saved to `form_*` custom fields; the research covers
 * only what the form does not ask.
 *
 * Research starts from the email domain (the identify step), so a personal
 * address (gmail.com and the rest of the skip list) gets a note saying so
 * instead of a run.
 */
import { timingSafeEqual } from 'node:crypto';

import type { EnrichmentField, EnrichmentResult } from '@/lib/types';
import { getSkipReason, loadSkipList, shouldSkipEmail } from '@/lib/utils/skip-list';

import type { FluentCrm } from './fluentcrm';
import { crmValue, pushToCrm } from './sync';

/**
 * What the brief researches: only what the booking form does not ask (the form
 * already has company, role and company size). Fixed, so the plan is cached
 * after the first booking.
 */
export const BOOKING_FIELDS: EnrichmentField[] = [
  { name: 'website', displayName: 'Website', description: 'The company website URL', type: 'string', required: false },
  {
    name: 'company_description',
    displayName: 'What They Do',
    description: 'What the company sells and to whom, in one or two sentences',
    type: 'string',
    required: false,
  },
  { name: 'industry', displayName: 'Industry', description: 'The industry the company works in', type: 'string', required: false },
  {
    name: 'services',
    displayName: 'Services',
    description: 'The main services or products the company offers',
    type: 'array',
    required: false,
  },
  {
    name: 'target_customers',
    displayName: 'Target Customers',
    description: 'Who the company sells to: customer type, size or industry',
    type: 'string',
    required: false,
  },
  {
    name: 'location',
    displayName: 'Location',
    description: 'Where the company is based: city and state or country',
    type: 'string',
    required: false,
  },
  {
    name: 'linkedin_url',
    displayName: 'LinkedIn',
    description: "The company's LinkedIn page URL",
    type: 'string',
    required: false,
  },
  {
    name: 'recent_news',
    displayName: 'Recent News',
    description: 'Notable news, launches or announcements from the last 12 months',
    type: 'string',
    required: false,
  },
];

export interface Booking {
  email: string;
  name: string;
  event?: string;
  startTime?: string;
  message?: string;
  /** Booking form answers, in form order. `key` is the form field's name. */
  answers: { key: string; label: string; value: string }[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): string | undefined => {
  const t = crmValue(v);
  return t && t !== '[object Object]' ? t : undefined;
};

/**
 * The booking in a FluentBooking webhook body, or null without an email.
 * Takes the booking ("all data") at the top level or under `booking`, with the
 * guest at the top level or under `guest`, and the form answers from
 * `custom_form_data` (`{ key: { label, value } }`) or `custom_fields`.
 */
export function parseBooking(body: unknown): Booking | null {
  if (!isObj(body)) return null;
  const booking = isObj(body.booking) ? { ...body, ...body.booking } : body;
  const guest = isObj(body.guest) ? body.guest : {};
  const email = text(booking.email) ?? text(guest.email);
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return null;

  const name =
    text(guest.full_name) ??
    ([text(booking.first_name) ?? text(guest.first_name), text(booking.last_name) ?? text(guest.last_name)]
      .filter(Boolean)
      .join(' ') ||
      email);

  const answers: Booking['answers'] = [];
  const form = isObj(booking.custom_form_data) ? booking.custom_form_data : isObj(booking.custom_fields) ? booking.custom_fields : {};
  for (const [key, entry] of Object.entries(form)) {
    const label = isObj(entry) ? (text(entry.label) ?? key) : key;
    const value = isObj(entry) ? text(entry.value) : text(entry);
    if (value) answers.push({ key, label, value });
  }

  return {
    email: email.toLowerCase(),
    name,
    event: text(booking.event_name) ?? text(booking.title)?.replace(/<[^>]+>/g, ''),
    startTime: text(booking.start_time),
    message: text(booking.message) ?? text(guest.note),
    answers,
  };
}

/** True when `given` is the shared secret. False when no secret is configured, so the hook is off until one is. */
export function hookSecretMatches(given: string | null | undefined, secret = process.env.BOOKING_HOOK_SECRET): boolean {
  const want = secret?.trim();
  if (!want || !given) return false;
  const a = Buffer.from(given.trim());
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Research one email: field name → finding. Null when the run was cancelled or failed. */
export type Research = (email: string) => Promise<Record<string, EnrichmentResult> | null>;

export interface BookingOutcome {
  contactId: number;
  status: 'researched' | 'skipped' | 'failed';
  found: string[];
  missing: string[];
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The note's HTML: the booking, then each finding with its source, then what was not found.
 * @public Exported for the tests.
 */
export function briefHtml(booking: Booking, findings: Record<string, EnrichmentResult> | null, skipped?: string): string {
  const parts: string[] = [];
  const when = [booking.event, booking.startTime].filter(Boolean).join(', ');
  if (when) parts.push(`<p><strong>Booking:</strong> ${esc(when)}</p>`);
  if (booking.message) parts.push(`<p><strong>Their note:</strong> ${esc(booking.message)}</p>`);
  if (booking.answers.length > 0) {
    parts.push(
      `<p><strong>Form answers</strong></p><ul>${booking.answers
        .map(({ label, value }) => `<li>${esc(label)}: ${esc(value)}</li>`)
        .join('')}</ul>`
    );
  }
  if (skipped) {
    parts.push(`<p><strong>Not researched:</strong> ${esc(skipped)}. Ask for a work email or company website.</p>`);
    return parts.join('');
  }
  if (!findings) {
    parts.push('<p><strong>Research failed.</strong> Run it again from Fire Enrich.</p>');
    return parts.join('');
  }
  const found = BOOKING_FIELDS.filter((f) => crmValue(findings[f.name]?.value) !== undefined);
  const missing = BOOKING_FIELDS.filter((f) => !found.includes(f));
  if (found.length > 0) {
    parts.push(
      `<p><strong>Research</strong></p><ul>${found
        .map((f) => {
          const r = findings[f.name];
          const source = r.source ? ` (<a href="${esc(r.source)}">source</a>)` : '';
          return `<li>${esc(f.displayName)}: ${esc(crmValue(r.value)!)}${source}</li>`;
        })
        .join('')}</ul>`
    );
  }
  if (missing.length > 0) {
    parts.push(`<p><strong>Not found:</strong> ${esc(missing.map((f) => f.displayName).join(', '))}</p>`);
  }
  return parts.join('');
}

/** The custom field a form answer is saved to: slug `form_<key>`, label `Form: <label>`. */
const formField = (a: { key: string; label: string }) => ({
  slug: `form_${a.key.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')}`,
  label: `Form: ${a.label}`,
});

/**
 * Save the booking form answers to the contact as custom fields (group
 * "Booking form"), adding the definitions that are missing, so the answers
 * live on the contact and not only in the note.
 */
async function saveFormAnswers(crm: FluentCrm, contactId: number, booking: Booking): Promise<void> {
  if (booking.answers.length === 0) return;
  const fields = booking.answers.map(formField);
  await crm.addCustomFields(fields, 'Booking form');
  await crm.setCustomValues(
    contactId,
    Object.fromEntries(booking.answers.map((a) => [formField(a).slug, a.value]))
  );
}

/**
 * Research the booker and write the result to their contact: the fields that
 * were found as custom fields (missing definitions are added, in the
 * "Fire Enrich" group), and one note with the whole brief.
 */
export async function processBooking(booking: Booking, crm: FluentCrm, research: Research): Promise<BookingOutcome> {
  const contactId = await crm.contactId(booking.email);
  const title = `Pre-call brief: ${booking.name}`;
  try {
    await saveFormAnswers(crm, contactId, booking);
  } catch (error) {
    console.warn(`[BOOKING] form answers not saved: ${error instanceof Error ? error.message : String(error)}`);
  }

  const skipList = await loadSkipList();
  if (shouldSkipEmail(booking.email, skipList)) {
    const reason = `${getSkipReason(booking.email, skipList)} (${booking.email.split('@')[1]})`;
    await crm.addNote(contactId, { title, description: briefHtml(booking, null, reason) });
    return { contactId, status: 'skipped', found: [], missing: BOOKING_FIELDS.map((f) => f.name) };
  }

  let findings: Record<string, EnrichmentResult> | null = null;
  try {
    findings = await research(booking.email);
  } catch (error) {
    console.warn(`[BOOKING] research failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  // The note is written even when the custom fields could not be: it holds the whole brief.
  if (findings) {
    const values = Object.fromEntries(Object.entries(findings).map(([name, r]) => [name, r.value]));
    try {
      await pushToCrm(crm, BOOKING_FIELDS, [{ email: booking.email, values }], { createFields: true });
    } catch (error) {
      console.warn(`[BOOKING] custom fields not written: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  await crm.addNote(contactId, { title, description: briefHtml(booking, findings) });

  const found = findings ? BOOKING_FIELDS.filter((f) => crmValue(findings![f.name]?.value) !== undefined).map((f) => f.name) : [];
  return {
    contactId,
    status: findings ? 'researched' : 'failed',
    found,
    missing: BOOKING_FIELDS.map((f) => f.name).filter((n) => !found.includes(n)),
  };
}
