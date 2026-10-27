/**
 * FluentCRM over its REST API (`/wp-json/fluent-crm/v2`), authenticated with a
 * WordPress application password (`FLUENTCRM_AUTH`, as `user:password`).
 *
 * It sends sign-in codes (`lib/auth/email.ts`), lists contacts for the pull
 * and writes enriched values back to contact custom fields for the push
 * (`lib/crm/sync.ts`).
 */

/** The FluentCRM site and credential from the environment, or null when either is unset. */
export function fluentCrmConfig(env = process.env): { url: string; auth: string } | null {
  const url = env.FLUENTCRM_URL?.trim();
  const auth = env.FLUENTCRM_AUTH?.trim();
  if (!url || !auth) return null;
  return { url: url.replace(/\/$/, ''), auth };
}

/** A contact as `GET /subscribers` returns it, with the fields the pull and push read. */
export interface CrmContact {
  id: number;
  email: string;
  first_name?: string | null;
  last_name?: string | null;
  phone?: string | null;
  city?: string | null;
  country?: string | null;
  company?: { name?: string | null } | null;
  /** Custom field values by slug. FluentCRM sends `[]` when a contact has none. */
  custom_fields?: Record<string, unknown> | unknown[] | null;
}

/** A contact custom field definition (`GET /custom-fields/contacts`). */
export interface CrmCustomField {
  slug: string;
  label: string;
  type: string;
  group?: string;
}

/** A list or a tag, the two ways the pull picks contacts. */
export interface CrmSegment {
  id: number;
  title: string;
}

const PAGE_SIZE = 100;

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

  /** The lists and tags contacts can be pulled by. */
  async segments(): Promise<{ lists: CrmSegment[]; tags: CrmSegment[] }> {
    const [lists, tags] = await Promise.all([
      this.call<{ lists: CrmSegment[] }>('GET', '/lists'),
      this.call<{ tags: CrmSegment[] | { data: CrmSegment[] } }>('GET', '/tags?per_page=500'),
    ]);
    const tagRows = Array.isArray(tags.tags) ? tags.tags : tags.tags.data;
    const pick = (s: CrmSegment) => ({ id: s.id, title: s.title });
    return { lists: lists.lists.map(pick), tags: tagRows.map(pick) };
  }

  /**
   * Contacts on a list or with a tag (or all of them), with their custom
   * values, page by page up to `limit`. `total` is how many match in all.
   */
  async contacts(filter: { list?: number; tag?: number; limit: number }): Promise<{ contacts: CrmContact[]; total: number }> {
    const contacts: CrmContact[] = [];
    let total = 0;
    for (let page = 1; contacts.length < filter.limit; page++) {
      const query = new URLSearchParams({ per_page: String(PAGE_SIZE), page: String(page), custom_fields: 'true' });
      if (filter.list) query.append('lists[]', String(filter.list));
      if (filter.tag) query.append('tags[]', String(filter.tag));
      const res = await this.call<{ subscribers: { data: CrmContact[]; total: number; last_page: number } }>(
        'GET',
        `/subscribers?${query}`
      );
      total = res.subscribers.total;
      contacts.push(...res.subscribers.data);
      if (page >= res.subscribers.last_page || res.subscribers.data.length === 0) break;
    }
    return { contacts: contacts.slice(0, filter.limit), total };
  }

  /** The contact custom fields defined on the site. */
  async customFields(): Promise<CrmCustomField[]> {
    return (await this.call<{ fields: CrmCustomField[] }>('GET', '/custom-fields/contacts')).fields;
  }

  /** The contact with exactly this email, with its custom values, or null. Never creates one. */
  async findContact(email: string): Promise<CrmContact | null> {
    const res = await this.call<{ subscribers: { data: CrmContact[] } }>(
      'GET',
      `/subscribers?search=${encodeURIComponent(email)}&per_page=10&custom_fields=true`
    );
    return res.subscribers.data.find((s) => s.email.toLowerCase() === email.toLowerCase()) ?? null;
  }

  /** Set some custom field values on a contact. Values not named are left as they are. */
  async setCustomValues(id: number, values: Record<string, string>): Promise<void> {
    await this.call('PUT', `/subscribers/${id}`, { custom_values: values });
  }
}
