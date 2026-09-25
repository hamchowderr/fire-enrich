import { NextResponse } from 'next/server';

import { doltConfigState } from '@/lib/dolt-config.mjs';
import { gatewayConfigured } from '@/lib/gateway-auth';

/**
 * Reports which variables are set, as booleans only. A value never leaves the
 * server: this route exists so the UI can tell "configured" from "not
 * configured", nothing more.
 *
 * `environmentStatus` holds what the app reads to run. Dolt is not among them:
 * it is optional, and an unset Dolt is not a missing setting. It is reported
 * under `optional.dolt` instead, with what it switches on, so a deployment
 * without it reads as "optional, not configured" rather than as a failure.
 * A partial Dolt (some `DOLT_*` set, `DOLT_HOST` or `DOLT_DATABASE` missing)
 * is reported as `misconfigured`, with the missing names: that one is a
 * mistake to fix, not a choice.
 *
 * Imports the config module, not `lib/dolt`, so this route never loads the
 * MySQL driver.
 */
export async function GET() {
  // On Vercel the AI Gateway authenticates with the deployment's OIDC token
  // and no key is set; `gatewayConfigured` counts either credential, reading
  // the token the way the gateway does (request context, then environment).
  const gateway = gatewayConfigured();
  const environmentStatus = {
    FIRECRAWL_API_KEY: !!process.env.FIRECRAWL_API_KEY,
    AI_GATEWAY_API_KEY: gateway,
    // The UI reads the gateway's presence under this name; keep it until the
    // UI is repackaged.
    OPENAI_API_KEY: gateway,
    TURSO_DATABASE_URL: !!process.env.TURSO_DATABASE_URL,
  };
  const dolt = doltConfigState();
  const optional = {
    dolt: {
      required: false,
      configured: dolt.state === 'on',
      misconfigured: dolt.state === 'misconfigured',
      // Variable names only, never values.
      missing: dolt.state === 'misconfigured' ? dolt.missing : [],
      enables: ['versioned run history', 'run diffs'],
    },
  };

  return NextResponse.json({ environmentStatus, optional });
}
