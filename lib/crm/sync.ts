/**
 * The FluentCRM pull and push, on the REST client in `lib/crm/fluentcrm.ts`.
 *
 * Pull: contacts on a list or with a tag become table rows, the same shape a
 * CSV upload gives (`email` first), so the rest of the app cannot tell them
 * apart.
 *
 * Push: an enriched field is written to the contact custom field that matches
 * it: slug `enrich_<name>` (the name a new one should get), or a slug equal to
 * the field's name, or a label equal to its display name. A field with no
 * matching custom field is reported, with the slug and label to create, and
 * left out: the push never changes the site's field definitions. Only values
 * that differ from what the contact already holds are sent, an unknown value
 * never clears one, and an email with no contact is skipped, never added.
 */
import type { EnrichmentField } from '@/lib/types';

import { type CrmContact, type CrmCustomField, FluentCrm, fluentCrmConfig } from './fluentcrm';

/** The client for the configured site, or null when `FLUENTCRM_URL` or `FLUENTCRM_AUTH` is unset. */
export function fluentCrm(env = process.env, fetchImpl: typeof fetch = fetch): FluentCrm | null {
  const config = fluentCrmConfig(env);
  return config ? new FluentCrm(config.url, config.auth, fetchImpl) : null;
}

const ROW_COLUMNS = ['email', 'first_name', 'last_name', 'company', 'phone', 'city', 'country'] as const;

/** Contacts as table rows. A column no contact has a value for is left out, except `email`. */
export function contactRows(contacts: CrmContact[]): { rows: Record<string, string>[]; columns: string[] } {
  const rows = contacts.map((c) => {
    const row: Record<string, string> = {};
    for (const column of ROW_COLUMNS) {
      const value = column === 'company' ? c.company?.name : c[column];
      row[column] = typeof value === 'string' ? value.trim() : '';
    }
    return row;
  });
  const columns = ROW_COLUMNS.filter((column) => column === 'email' || rows.some((row) => row[column]));
  return { rows: rows.map((row) => Object.fromEntries(columns.map((c) => [c, row[c]]))), columns: [...columns] };
}

const slugify = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

export interface FieldMapping {
  /** Enriched field name → custom field slug. */
  mapped: { field: string; slug: string; label: string }[];
  /** Fields with no custom field, and what to create for each. */
  unmatched: { field: string; slug: string; label: string }[];
}

/** @public Exported for the tests. */
export function mapFields(fields: Pick<EnrichmentField, 'name' | 'displayName'>[], crmFields: CrmCustomField[]): FieldMapping {
  const mapping: FieldMapping = { mapped: [], unmatched: [] };
  for (const field of fields) {
    const slug = `enrich_${slugify(field.name)}`;
    const match =
      crmFields.find((f) => f.slug === slug) ??
      crmFields.find((f) => f.slug === field.name || f.slug === slugify(field.name)) ??
      crmFields.find((f) => f.label.trim().toLowerCase() === field.displayName.trim().toLowerCase());
    if (match) mapping.mapped.push({ field: field.name, slug: match.slug, label: match.label });
    else mapping.unmatched.push({ field: field.name, slug, label: `Enrich: ${field.displayName}` });
  }
  return mapping;
}

/**
 * A value as a custom field holds it, or undefined for no value (which is never sent).
 * @public Exported for the tests.
 */
export function crmValue(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) {
    const joined = value.map((v) => String(v).trim()).filter(Boolean).join(', ');
    return joined || undefined;
  }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  const text = String(value).trim();
  return text || undefined;
}

function currentValues(contact: CrmContact): Record<string, string> {
  const fields = contact.custom_fields;
  if (!fields || Array.isArray(fields)) return {};
  return Object.fromEntries(Object.entries(fields).map(([slug, v]) => [slug, crmValue(v) ?? '']));
}

export interface PushRow {
  email: string;
  /** Enriched field name → value, as the enrichment returned it. */
  values: Record<string, unknown>;
}

export interface PushSummary {
  mapping: FieldMapping;
  updated: string[];
  unchanged: string[];
  notInCrm: string[];
  failed: { email: string; error: string }[];
}

const CONCURRENCY = 4;

/** Write the rows' values to their contacts. With `dryRun`, only work out the field mapping. */
export async function pushToCrm(
  crm: FluentCrm,
  fields: Pick<EnrichmentField, 'name' | 'displayName'>[],
  rows: PushRow[],
  options: { dryRun?: boolean } = {}
): Promise<PushSummary> {
  const mapping = mapFields(fields, await crm.customFields());
  const summary: PushSummary = { mapping, updated: [], unchanged: [], notInCrm: [], failed: [] };
  if (options.dryRun || mapping.mapped.length === 0) return summary;

  const queue = [...rows];
  const work = async () => {
    for (let row = queue.shift(); row; row = queue.shift()) {
      const email = row.email.trim();
      try {
        const contact = await crm.findContact(email);
        if (!contact) {
          summary.notInCrm.push(email);
          continue;
        }
        const current = currentValues(contact);
        const changes: Record<string, string> = {};
        for (const { field, slug } of mapping.mapped) {
          const value = crmValue(row.values[field]);
          if (value !== undefined && value !== current[slug]) changes[slug] = value;
        }
        if (Object.keys(changes).length === 0) {
          summary.unchanged.push(email);
          continue;
        }
        await crm.setCustomValues(contact.id, changes);
        summary.updated.push(email);
      } catch (error) {
        summary.failed.push({ email, error: error instanceof Error ? error.message : String(error) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, work));
  return summary;
}
