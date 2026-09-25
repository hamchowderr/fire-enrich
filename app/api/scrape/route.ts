import { NextRequest, NextResponse } from 'next/server';
import { Firecrawl } from 'firecrawl';
import type { ScrapeOptions } from 'firecrawl';
import { isRateLimited } from '@/lib/rate-limit';

interface ScrapeRequestBody {
  url?: string;
  urls?: string[];
  [key: string]: unknown;
}

interface ScrapeResult {
  success: boolean;
  data?: Record<string, unknown>;
  error?: string;
}

interface ApiError extends Error {
  status?: number;
}

export async function POST(request: NextRequest) {
  const rateLimit = await isRateLimited(request, 'scrape');
  
  if (!rateLimit.success) {
    return NextResponse.json({ 
      success: false,
      error: 'Rate limit exceeded. Please try again later.' 
    }, { 
      status: 429,
      headers: {
        'X-RateLimit-Limit': rateLimit.limit.toString(),
        'X-RateLimit-Remaining': rateLimit.remaining.toString(),
      }
    });
  }

  // The key comes from the environment only. It is injected from the secrets
  // manager at runtime and is never read from the request.
  const apiKey = process.env.FIRECRAWL_API_KEY;

  if (!apiKey) {
    return NextResponse.json({
      success: false,
      error: 'API configuration error. Please try again later or contact support.',
    }, { status: 500 });
  }

  try {
    const app = new Firecrawl({ apiKey });
    const body = await request.json() as ScrapeRequestBody;
    const { url, urls, ...params } = body;

    let result: ScrapeResult;

    if (url && typeof url === 'string') {
      const document = await app.scrape(url, params as ScrapeOptions);
      result = { success: true, data: document as Record<string, unknown> };
    } else if (urls && Array.isArray(urls)) {
      const job = await app.batchScrape(urls, { options: params as ScrapeOptions });
      result = {
        success: job.status === 'completed',
        data: job as unknown as Record<string, unknown>,
        ...(job.status === 'completed' ? {} : { error: `Batch scrape ${job.status}` }),
      };
    } else {
      return NextResponse.json({ success: false, error: 'Invalid request format. Please check your input and try again.' }, { status: 400 });
    }

    return NextResponse.json(result);

  } catch (error: unknown) {
    console.error('Error in /api/scrape endpoint (SDK):', error);
    const err = error as ApiError;
    const errorStatus = typeof err.status === 'number' ? err.status : 500;
    return NextResponse.json({ success: false, error: 'An error occurred while processing your request. Please try again later.' }, { status: errorStatus });
  }
} 
