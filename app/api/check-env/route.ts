import { NextResponse } from 'next/server';

export async function GET() {
  const environmentStatus = {
    FIRECRAWL_API_KEY: !!process.env.FIRECRAWL_API_KEY,
    // Reports AI_GATEWAY_API_KEY presence under the key name the UI already reads.
    OPENAI_API_KEY: !!process.env.AI_GATEWAY_API_KEY,
    ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY,
    FIRESTARTER_DISABLE_CREATION_DASHBOARD: process.env.FIRESTARTER_DISABLE_CREATION_DASHBOARD === 'true',
  };

  return NextResponse.json({ environmentStatus });
} 