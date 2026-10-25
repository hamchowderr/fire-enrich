/**
 * Sign-in on Better Auth, with emailed 6-digit codes and no passwords. Only
 * the addresses in `AUTH_ALLOWED_EMAILS` can get a code or an account (see
 * `lib/auth/config.ts`), so a deployment is the deployer's alone and nobody
 * else can spend its Firecrawl and AI Gateway credits.
 *
 * Better Auth's tables (`auth_user`, `auth_session`, `auth_account`,
 * `auth_verification`) live in the app's libSQL database next to profiles and
 * plans, created with them from `lib/app-db-schema.mjs`. `middleware.ts`
 * checks the session on every page and API route.
 */
import { hkdfSync } from 'node:crypto';

import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { APIError } from 'better-auth/api';
import { emailOTP } from 'better-auth/plugins';

import { type Env, isAllowedEmail } from '@/lib/auth/config';
import { sendSignInCode } from '@/lib/auth/email';
import { appDbDialect } from '@/lib/auth/libsql-dialect';

const NOT_ALLOWED = 'This email cannot sign in to this Fire Enrich.';

/**
 * `BETTER_AUTH_SECRET` when set. Otherwise one derived from the Turso token, a
 * secret every deployment already has, so a deploy needs no new variable;
 * rotating the token signs everyone out. Off Vercel with neither, a fixed
 * development secret.
 * @public Exported for the tests.
 */
export function authSecret(env: Env = process.env): string {
  if (env.BETTER_AUTH_SECRET) return env.BETTER_AUTH_SECRET;
  const token = env.TURSO_AUTH_TOKEN;
  if (token) return Buffer.from(hkdfSync('sha256', token, 'fire-enrich', 'better-auth-v1', 32)).toString('hex');
  if (!env.VERCEL) return 'fire-enrich-local-development-secret';
  throw new Error('Sign-in needs BETTER_AUTH_SECRET (or TURSO_AUTH_TOKEN, which it is derived from)');
}

/**
 * The base URL: `BETTER_AUTH_URL` when set (a custom domain, or a host behind
 * a proxy), else the request's own host when it is a Vercel or local one.
 */
function baseURL(env: Env = process.env): BetterAuthOptions['baseURL'] {
  if (env.BETTER_AUTH_URL) return env.BETTER_AUTH_URL;
  return {
    allowedHosts: ['*.vercel.app', 'localhost:*', '127.0.0.1:*', 'localhost', '127.0.0.1'],
    protocol: env.VERCEL ? 'https' : 'http',
  };
}

function authConfig(options: { sendCode?: (email: string, code: string) => Promise<void> } = {}) {
  const sendCode = options.sendCode ?? sendSignInCode;
  return {
    appName: 'Fire Enrich',
    baseURL: baseURL(),
    secret: authSecret(),
    database: { dialect: appDbDialect(), type: 'sqlite' },
    user: { modelName: 'auth_user' },
    session: { modelName: 'auth_session', expiresIn: 30 * 24 * 60 * 60, updateAge: 24 * 60 * 60 },
    account: { modelName: 'auth_account' },
    verification: { modelName: 'auth_verification' },
    emailAndPassword: { enabled: false },
    telemetry: { enabled: false },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            if (!isAllowedEmail(user.email)) throw new APIError('FORBIDDEN', { message: NOT_ALLOWED });
            return { data: user };
          },
        },
      },
    },
    plugins: [
      emailOTP({
        otpLength: 6,
        expiresIn: 10 * 60,
        allowedAttempts: 5,
        async sendVerificationOTP({ email, otp, type }) {
          // Better Auth answers the same either way, so the page never says which emails may sign in.
          if (type !== 'sign-in' || !isAllowedEmail(email)) return;
          await sendCode(email, otp);
        },
      }),
    ],
  } satisfies BetterAuthOptions;
}

const makeAuth = (options?: Parameters<typeof authConfig>[0]) => betterAuth(authConfig(options));
export type Auth = ReturnType<typeof makeAuth>;

const globalForAuth = globalThis as typeof globalThis & { __fireEnrichAuth?: Auth };

export function getAuth(): Auth {
  return (globalForAuth.__fireEnrichAuth ??= makeAuth());
}

/** Tests build an auth with their own code sender, or clear it. @public Used by the tests only. */
export function setAuth(options?: Parameters<typeof authConfig>[0]): Auth | undefined {
  globalForAuth.__fireEnrichAuth = options ? makeAuth(options) : undefined;
  return globalForAuth.__fireEnrichAuth;
}

/** The signed-in user's email for this request, or null. */
export async function sessionEmail(headers: Headers): Promise<string | null> {
  const session = await getAuth().api.getSession({ headers });
  const email = session?.user.email;
  // Re-checked on every request, so removing an address from the list signs it out at once.
  return email && isAllowedEmail(email) ? email : null;
}
