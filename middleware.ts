import { type NextRequest, NextResponse } from 'next/server';

import { authDisabled } from '@/lib/auth/config';
import { sessionEmail } from '@/lib/auth';

/**
 * Every page and API route needs a signed-in, allowed user (`lib/auth`),
 * except the sign-in page and Better Auth's own endpoints. A page redirects to
 * /sign-in; an API route answers 401, so the UI's fetches fail plainly.
 *
 * Runs on the Node.js runtime so the session is checked against the database
 * here, not just by the cookie's presence.
 */
export async function middleware(request: NextRequest) {
  if (authDisabled()) return NextResponse.next();

  const { pathname } = request.nextUrl;
  if (pathname === '/sign-in' || pathname.startsWith('/api/auth/')) return NextResponse.next();

  if (await sessionEmail(request.headers)) return NextResponse.next();

  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'Sign in to use Fire Enrich.' }, { status: 401 });
  }
  const signIn = new URL('/sign-in', request.url);
  if (pathname !== '/') signIn.searchParams.set('next', pathname);
  return NextResponse.redirect(signIn);
}

export const config = {
  runtime: 'nodejs',
  // Everything but Next's own assets and files with an extension from public/.
  matcher: ['/((?!_next/static|_next/image|.*\\.[a-zA-Z0-9]+$).*)'],
};
