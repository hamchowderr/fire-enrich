import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { NextRequest } from "next/server";

/**
 * Rate limiting is optional. It is on only when both UPSTASH_REDIS_REST_URL and
 * UPSTASH_REDIS_REST_TOKEN are set, in every environment; otherwise requests
 * are never limited and one info line says so.
 */
const upstashConfigured = () =>
  Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);

let loggedDisabled = false;

// Create a new ratelimiter that allows 50 requests per day per IP per endpoint
const getRateLimiter = (endpoint: string) => {
  if (!upstashConfigured()) {
    if (!loggedDisabled) {
      loggedDisabled = true;
      console.info(
        "[rate-limit] UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are not both set; rate limiting is off.",
      );
    }
    return null;
  }

  return new Ratelimit({
    redis: Redis.fromEnv(),
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
