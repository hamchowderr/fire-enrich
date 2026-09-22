import { type NextRequest, NextResponse } from 'next/server';

import { mastra } from '@/lib/mastra';

/**
 * TEMPORARY smoke-test route.
 *
 * `POST { message }` → `{ text }` through the temporary smoke agent. It exists
 * so the test harness can drive a Next.js route handler through Mastra and
 * AIMock end to end (`tests/routes/smoke.test.ts`), and it proves the Mastra
 * singleton works inside a Next route and survives `next build` with
 * `serverExternalPackages`.
 *
 * DELETE THIS FILE together with `lib/mastra/agents/smoke.ts` when the real
 * planner agent and its route land.
 */
export async function POST(request: NextRequest) {
  let body: { message?: unknown };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Request body must be JSON' }, { status: 400 });
  }

  const { message } = body;

  if (typeof message !== 'string' || message.trim().length === 0) {
    return NextResponse.json({ error: '`message` must be a non-empty string' }, { status: 400 });
  }

  const result = await mastra.getAgent('smoke').generate(message);

  return NextResponse.json({ text: result.text });
}
