import { NextResponse } from 'next/server';

/**
 * Reports which variables are set, as booleans only. A value never leaves the
 * server: this route exists so the UI can tell "configured" from "not
 * configured", nothing more.
 */
export async function GET() {
  const environmentStatus = {
    FIRECRAWL_API_KEY: !!process.env.FIRECRAWL_API_KEY,
    AI_GATEWAY_API_KEY: !!process.env.AI_GATEWAY_API_KEY,
    // The UI reads the gateway key's presence under this name; keep it until
    // the UI is repackaged.
    OPENAI_API_KEY: !!process.env.AI_GATEWAY_API_KEY,
    TURSO_DATABASE_URL: !!process.env.TURSO_DATABASE_URL,
    DOLT_HOST: !!process.env.DOLT_HOST,
  };

  return NextResponse.json({ environmentStatus });
}
