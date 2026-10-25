import { toNextJsHandler } from 'better-auth/next-js';

import { getAuth } from '@/lib/auth';

/** Better Auth's endpoints (send code, sign in, session, sign out) under /api/auth. */
export const { GET, POST } = toNextJsHandler((request) => getAuth().handler(request));
