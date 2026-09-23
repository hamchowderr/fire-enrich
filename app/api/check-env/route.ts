import { NextResponse } from 'next/server';

/**
 * Reports which variables are set, as booleans only. A value never leaves the
 * server: this route exists so the UI can tell "configured" from "not
 * configured", nothing more.
 */
export async function GET() {
  // On Vercel the AI Gateway authenticates with the deployment's OIDC token
  // and no key is set, so the token counts as "configured" too.
  const gateway = !!process.env.AI_GATEWAY_API_KEY || !!process.env.VERCEL_OIDC_TOKEN;
  const environmentStatus = {
    FIRECRAWL_API_KEY: !!process.env.FIRECRAWL_API_KEY,
    AI_GATEWAY_API_KEY: gateway,
    // The UI reads the gateway's presence under this name; keep it until the
    // UI is repackaged.
    OPENAI_API_KEY: gateway,
    TURSO_DATABASE_URL: !!process.env.TURSO_DATABASE_URL,
    DOLT_HOST: !!process.env.DOLT_HOST,
  };

  return NextResponse.json({ environmentStatus });
}
