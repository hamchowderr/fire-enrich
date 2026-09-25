/**
 * HTTP glue for the run-history routes (`/api/runs/...`).
 *
 * Versioned run history is what Dolt is for, and Dolt is optional
 * (`lib/dolt-config.mjs`): a deployment without it enriches as usual and
 * simply keeps no run history. So an unconfigured Dolt is not a failure, and
 * these routes do not answer it with a 503.
 *
 * Route files hold only the handlers Next.js looks for by convention, so this
 * lives outside `app/`.
 */
import { NextResponse } from 'next/server';

import { isDoltConfigured } from '@/lib/dolt';
import { DOLT_REQUIRED_VARS, doltConfigState, doltMisconfiguredMessage } from '@/lib/dolt-config.mjs';

/**
 * The "requires Dolt" answer when Dolt is not configured, `null` when it is.
 *
 * 501 Not Implemented: "the server does not support the functionality
 * required to fulfill the request", which is exactly a deployment that runs
 * without the optional run history. It is a different status from the 503 a
 * configured-but-unreachable database would be. The body is
 *
 *     { error, code: 'dolt_not_configured', feature, requires: 'dolt', env: ['DOLT_HOST', 'DOLT_DATABASE'] }
 *
 * `error` names the feature and the variables that enable it; `code` and
 * `requires` let a client show an "enable Dolt" state instead of an error.
 * The UI does not reach it: without Dolt no run is committed, `complete`
 * carries `runId: null`, and the table asks for no diff.
 *
 * A misconfigured Dolt (some `DOLT_*` set, a required one missing) is a
 * mistake, not a choice, so it answers 503 with `code: 'dolt_misconfigured'`
 * and the missing variable names instead.
 */
export function requireRunHistory(feature = 'Run history'): NextResponse | null {
  if (isDoltConfigured()) return null;

  const config = doltConfigState();
  if (config.state === 'misconfigured') {
    return NextResponse.json(
      {
        error: `${feature} is unavailable. ${doltMisconfiguredMessage(config)}`,
        code: 'dolt_misconfigured',
        feature,
        requires: 'dolt',
        missing: config.missing,
      },
      { status: 503 }
    );
  }

  return NextResponse.json(
    {
      error: `${feature} requires Dolt, which is optional and not configured in this deployment. Set ${DOLT_REQUIRED_VARS.join(' and ')} (see .env.example) to enable it.`,
      code: 'dolt_not_configured',
      feature,
      requires: 'dolt',
      env: [...DOLT_REQUIRED_VARS],
    },
    { status: 501 }
  );
}
