import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { crmFailed, crmNotConfigured } from '@/lib/api/crm-http';
import { badRequest, parseJsonBody } from '@/lib/api/profiles-http';
import { fluentCrm, pushToCrm } from '@/lib/crm/sync';

const pushSchema = z.object({
  fields: z.array(z.object({ name: z.string().min(1), displayName: z.string().min(1) })).min(1),
  rows: z.array(z.object({ email: z.string().email(), values: z.record(z.string(), z.unknown()) })).max(1000),
  dryRun: z.boolean().optional(),
});

/**
 * `POST /api/crm/push` → write enriched values to the contacts' custom fields
 * (`lib/crm/sync.ts`). With `dryRun`, only the field mapping, nothing written.
 */
export async function POST(request: NextRequest) {
  const crm = fluentCrm();
  if (!crm) return crmNotConfigured();
  const body = await parseJsonBody(request);
  if (body.error) return body.error;
  const parsed = pushSchema.safeParse(body.value);
  if (!parsed.success) return badRequest(parsed.error, 'push');
  try {
    const { fields, rows, dryRun } = parsed.data;
    return NextResponse.json(
      await pushToCrm(
        crm,
        fields.map((f) => ({ name: f.name!, displayName: f.displayName! })),
        rows.map((r) => ({ email: r.email!, values: r.values ?? {} })),
        { dryRun }
      )
    );
  } catch (error) {
    return crmFailed(error);
  }
}
