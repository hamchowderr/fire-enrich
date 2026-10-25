/**
 * FluentCRM over its REST API (`/wp-json/fluent-crm/v2`), authenticated with a
 * WordPress application password (`FLUENTCRM_AUTH`, as `user:password`).
 *
 * Today it only sends sign-in codes (`lib/auth/email.ts`); the list pull and
 * the results push build on the same client.
 */

/** The FluentCRM site and credential from the environment, or null when either is unset. */
export function fluentCrmConfig(env = process.env): { url: string; auth: string } | null {
  const url = env.FLUENTCRM_URL?.trim();
  const auth = env.FLUENTCRM_AUTH?.trim();
  if (!url || !auth) return null;
  return { url: url.replace(/\/$/, ''), auth };
}

export class FluentCrm {
  constructor(
    private readonly baseUrl: string,
    private readonly auth: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}/wp-json/fluent-crm/v2${path}`, {
      method,
      headers: {
        authorization: `Basic ${Buffer.from(this.auth).toString('base64')}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    // The status only: FluentCRM's error bodies can echo the request.
    if (!res.ok) throw new Error(`FluentCRM ${method} ${path.split('?')[0]} answered ${res.status}`);
    return (await res.json()) as T;
  }

  /**
   * The contact id for this email. A missing contact is added as
   * `transactional` (no marketing opt-in); an existing one keeps its status,
   * so an unsubscribe is never undone.
   */
  async contactId(email: string): Promise<number> {
    const search = await this.call<{ subscribers: { data: { id: number; email: string }[] } }>(
      'GET',
      `/subscribers?search=${encodeURIComponent(email)}&per_page=10`
    );
    const found = search.subscribers.data.find((s) => s.email.toLowerCase() === email.toLowerCase());
    if (found) return found.id;
    const created = await this.call<{ contact: { id: number } }>('POST', '/subscribers', {
      email,
      status: 'transactional',
    });
    return created.contact.id;
  }

  /** A one-off email through the site's own mailer ("send email to contact"), sent at once. */
  async sendEmail(email: string, message: { subject: string; html: string }): Promise<void> {
    const id = await this.contactId(email);
    await this.call('POST', `/subscribers/${id}/emails/send`, {
      campaign: { email_subject: message.subject, email_body: message.html },
    });
  }
}
