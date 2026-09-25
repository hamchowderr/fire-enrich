import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { NextRequest } from "next/server";

/**
 * Rate limiting is optional. It is on only when one complete pair of Upstash
 * REST credentials is set, in every environment: UPSTASH_REDIS_REST_URL and
 * UPSTASH_REDIS_REST_TOKEN, or KV_REST_API_URL and KV_REST_API_TOKEN (the names
 * Vercel's Upstash integration injects). A half pair, or one variable from each,
 * does not count. Otherwise requests are never limited and one info line says so.
 *
 * The pair is resolved here rather than by `Redis.fromEnv()`, which picks the
 * URL and the token independently and could combine one pair's URL with the
 * other pair's token.
 */
const upstashCredentials = (): { url: string; token: string } | null => {
  const pairs = [
    [process.env.UPSTASH_REDIS_REST_URL, process.env.UPSTASH_REDIS_REST_TOKEN],
    [process.env.KV_REST_API_URL, process.env.KV_REST_API_TOKEN],
  ];
  for (const [url, token] of pairs) {
    if (url && token) return { url, token };
  }
  return null;
};

let loggedDisabled = false;

// Create a new ratelimiter that allows 50 requests per day per IP per endpoint
const getRateLimiter = (endpoint: string) => {
  const credentials = upstashCredentials();
  if (!credentials) {
    if (!loggedDisabled) {
      loggedDisabled = true;
      console.info(
        "[rate-limit] No complete Upstash credentials (UPSTASH_REDIS_REST_URL/TOKEN or KV_REST_API_URL/TOKEN); rate limiting is off.",
      );
    }
    return null;
  }

  return new Ratelimit({
    redis: new Redis(credentials),
    limiter: Ratelimit.fixedWindow(50, "1 d"),
    analytics: true,
    prefix: `ratelimit:${endpoint}`,
  });
};

// Helper function to get the IP from a NextRequest or default to a placeholder
const getIP = (request: NextRequest): string => {
  const forwarded = request.headers.get("x-forwarded-for");
  const realIp = request.headers.get("x-real-ip");

  if (forwarded) {
    return forwarded.split(/, /)[0];
  }

  if (realIp) {
    return realIp;
  }

  // Default to placeholder IP if none found
  return "127.0.0.1";
};

// Helper function to check if a request is rate limited
export const isRateLimited = async (request: NextRequest, endpoint: string) => {
  const limiter = getRateLimiter(endpoint);

  // Upstash is not configured: allow the request
  if (!limiter) {
    return { success: true, limit: 50, remaining: 50 };
  }

  // Get the IP from the request
  const ip = getIP(request);

  // Check if the IP has exceeded the rate limit
  const result = await limiter.limit(ip);

  return {
    success: result.success,
    limit: result.limit,
    remaining: result.remaining,
  };
};
