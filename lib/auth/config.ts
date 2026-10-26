/**
 * Who may sign in, and whether sign-in is required, from the environment.
 * No database or Better Auth import, so `check-env` can read it cheaply.
 *
 * Sign-in is always required, except off Vercel with `AUTH_DISABLED=1` (local
 * development and the Playwright smoke). On Vercel that flag is ignored, so a
 * deployment can never be opened by a stray variable.
 *
 * Only the addresses in `AUTH_ALLOWED_EMAILS` (comma or space separated) can
 * get a code or an account. With none set, nobody can sign in: the instance
 * stays closed rather than open.
 */

/** The variables read here; `process.env` by default. */
export type Env = Record<string, string | undefined>;

export function authDisabled(env: Env = process.env): boolean {
  return !env.VERCEL && env.AUTH_DISABLED === '1';
}

export function allowedEmails(env: Env = process.env): Set<string> {
  return new Set(
    (env.AUTH_ALLOWED_EMAILS ?? '')
      .split(/[\s,]+/)
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean)
  );
}

export function isAllowedEmail(email: string, env: Env = process.env): boolean {
  return allowedEmails(env).has(email.trim().toLowerCase());
}

/** How sign-in codes are sent: the first configured of FluentCRM and Resend, else the server log off Vercel. */
export function codeSender(env: Env = process.env): 'fluentcrm' | 'resend' | 'log' | null {
  if (env.FLUENTCRM_URL?.trim() && env.FLUENTCRM_AUTH?.trim()) return 'fluentcrm';
  if (env.RESEND_API_KEY?.trim() && env.AUTH_EMAIL_FROM?.trim()) return 'resend';
  return env.VERCEL ? null : 'log';
}
