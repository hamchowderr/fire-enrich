import { codeSender } from '@/lib/auth/config';
import { FluentCrm, fluentCrmConfig } from '@/lib/crm/fluentcrm';

function message(code: string) {
  return {
    subject: `${code} is your Fire Enrich sign-in code`,
    html: `<p>Your Fire Enrich sign-in code is:</p>
<p style="font-size:28px;font-weight:700;letter-spacing:4px">${code}</p>
<p>It works once and expires in 10 minutes. If you didn't try to sign in, you can ignore this email.</p>`,
  };
}

/**
 * Send a sign-in code by the sender `codeSender` picks: FluentCRM's
 * "send email to contact" (`FLUENTCRM_URL`, `FLUENTCRM_AUTH`), Resend
 * (`RESEND_API_KEY`, from `AUTH_EMAIL_FROM`), or, off Vercel with neither, the
 * server log, so local development needs no mail account.
 */
export async function sendSignInCode(email: string, code: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const sender = codeSender();
  if (sender === 'fluentcrm') {
    const { url, auth } = fluentCrmConfig()!;
    await new FluentCrm(url, auth, fetchImpl).sendEmail(email, message(code));
    return;
  }
  if (sender === 'resend') {
    const res = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: process.env.AUTH_EMAIL_FROM, to: [email], ...message(code) }),
    });
    if (!res.ok) throw new Error(`Resend answered ${res.status}`);
    return;
  }
  if (sender === 'log') {
    console.info(`[AUTH] Sign-in code for ${email}: ${code} (no email sender configured; shown here off Vercel only)`);
    return;
  }
  throw new Error('Sign-in codes need FLUENTCRM_URL and FLUENTCRM_AUTH, or RESEND_API_KEY and AUTH_EMAIL_FROM');
}
