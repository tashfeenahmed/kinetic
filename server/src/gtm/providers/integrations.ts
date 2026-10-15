/** Outbound actions (Slack, webhooks, HubSpot, Salesforce) and CRM imports. */
import { getJson, request } from '../lib/http.ts';
import type { Settings } from '../settings.ts';
import type { Hit } from './types.ts';

export interface FieldMap { name: string; value: unknown }

// ---------- Slack ----------
export async function slackPost(settings: Settings, opts: { text: string; channel?: string; webhookUrl?: string }): Promise<Hit> {
  const token = settings.get('SLACK_BOT_TOKEN');
  if (opts.channel && token) {
    const d = await getJson('https://slack.com/api/chat.postMessage', { headers: { authorization: `Bearer ${token}` }, json: { channel: opts.channel, text: opts.text, unfurl_links: false } });
    if (!d.ok) throw new Error(`Slack: ${d.error}`);
    return { value: 'sent', data: { channel: d.channel, ts: d.ts } };
  }
  const url = opts.webhookUrl || settings.get('SLACK_WEBHOOK_URL');
  if (!url) throw new Error('Set a Slack incoming webhook URL (Settings or column) or a bot token + channel');
  const res = await request(url, { json: { text: opts.text } });
  if (!res.ok) throw new Error(`Slack webhook ${res.status}: ${await res.text()}`);
  return { value: 'sent', data: { via: 'webhook' } };
}

/** True when a Slack post has somewhere to go. */
export function slackReady(settings: Settings, opts: { channel?: string; webhookUrl?: string }): boolean {
  return !!((opts.channel && settings.has('SLACK_BOT_TOKEN')) || opts.webhookUrl || settings.has('SLACK_WEBHOOK_URL'));
}

// ---------- ntfy (free, open-source push notifications) ----------
export async function ntfyPost(settings: Settings, opts: { title: string; text: string }): Promise<Hit> {
  const topic = settings.get('NTFY_TOPIC');
  if (!topic) throw new Error('Set an ntfy topic');
  const base = (settings.get('NTFY_URL') || 'https://ntfy.sh').replace(/\/+$/, '');
  // Slack markup (*bold*, :emoji:) reads as noise in a push notification.
  const text = opts.text.replace(/:[a-z_]+:\s*/g, '').replace(/\*([^*\n]+)\*/g, '$1');
  const res = await request(`${base}/${encodeURIComponent(topic)}`, { method: 'POST', body: text, headers: { title: opts.title.replace(/[^\x20-\x7e]/g, '').slice(0, 200), tags: 'satellite' } });
  if (!res.ok) throw new Error(`ntfy ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return { value: 'sent', data: { via: 'ntfy' } };
}

// ---------- Generic webhook / HTTP ----------
export async function callHttp(opts: { url: string; method?: string; headers?: Record<string, string>; body?: unknown }): Promise<Hit> {
  const hasBody = opts.body !== undefined && opts.body !== '' && !['GET', 'HEAD'].includes((opts.method ?? 'POST').toUpperCase());
  const res = await request(opts.url, {
    method: (opts.method ?? (hasBody ? 'POST' : 'GET')).toUpperCase(),
    headers: opts.headers,
    ...(hasBody ? (typeof opts.body === 'string' ? { body: opts.body } : { json: opts.body }) : {}),
  });
  const text = await res.text();
  let data: unknown = text;
  try { data = JSON.parse(text); } catch { /* text */ }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  return { value: data, data: { status: res.status } };
}

// ---------- HubSpot (private app token) ----------
const HS = 'https://api.hubapi.com';
const hsHeaders = (s: Settings) => {
  const t = s.get('HUBSPOT_TOKEN');
  if (!t) throw new Error('Set HUBSPOT_TOKEN (private app access token) on the Integrations page');
  return { authorization: `Bearer ${t}` };
};

function props(fields: FieldMap[]) {
  return Object.fromEntries(fields.filter((f) => f.name && f.value != null && f.value !== '').map((f) => [f.name, typeof f.value === 'object' ? JSON.stringify(f.value) : String(f.value)]));
}

export async function hubspotUpsertContact(s: Settings, email: string, fields: FieldMap[]): Promise<Hit> {
  if (!email) throw new Error('Contact upsert needs an email');
  const d = await getJson(`${HS}/crm/v3/objects/contacts/batch/upsert`, {
    method: 'POST', headers: hsHeaders(s),
    json: { inputs: [{ idProperty: 'email', id: email, properties: { email, ...props(fields) } }] },
  });
  const r = d.results?.[0];
  return { value: r?.id, data: { new: r?.new, url: r?.id ? `https://app.hubspot.com/contacts/_/record/0-1/${r.id}` : undefined } };
}

export async function hubspotUpsertCompany(s: Settings, domain: string, fields: FieldMap[]): Promise<Hit> {
  if (!domain) throw new Error('Company upsert needs a domain');
  const found = await getJson(`${HS}/crm/v3/objects/companies/search`, {
    method: 'POST', headers: hsHeaders(s),
    json: { filterGroups: [{ filters: [{ propertyName: 'domain', operator: 'EQ', value: domain }] }], limit: 1 },
  });
  const id = found.results?.[0]?.id;
  const properties = { domain, ...props(fields) };
  const d = id
    ? await getJson(`${HS}/crm/v3/objects/companies/${id}`, { method: 'PATCH', headers: hsHeaders(s), json: { properties } })
    : await getJson(`${HS}/crm/v3/objects/companies`, { method: 'POST', headers: hsHeaders(s), json: { properties } });
  return { value: d.id, data: { new: !id } };
}

export async function hubspotImport(s: Settings, object: 'contacts' | 'companies', properties: string[], limit: number): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  let after: string | undefined;
  while (out.length < limit) {
    const d = await getJson(`${HS}/crm/v3/objects/${object}`, { headers: hsHeaders(s), query: { limit: Math.min(100, limit - out.length), properties: properties.join(','), after } });
    for (const r of d.results ?? []) out.push({ 'HubSpot ID': r.id, ...r.properties });
    after = d.paging?.next?.after;
    if (!after) break;
  }
  return out.map((r) => { delete (r as any).hs_object_id; delete (r as any).createdate; delete (r as any).lastmodifieddate; return r; });
}

// ---------- Salesforce (OAuth client-credentials flow on a Connected App / External Client App) ----------
let sfToken: { token: string; instance: string; expires: number } | null = null;

async function salesforceAuth(s: Settings) {
  if (sfToken && sfToken.expires > Date.now()) return sfToken;
  const domain = s.get('SALESFORCE_DOMAIN');
  const id = s.get('SALESFORCE_CLIENT_ID');
  const secret = s.get('SALESFORCE_CLIENT_SECRET');
  if (!domain || !id || !secret) throw new Error('Set SALESFORCE_DOMAIN (e.g. acme.my.salesforce.com), SALESFORCE_CLIENT_ID and SALESFORCE_CLIENT_SECRET');
  const base = domain.startsWith('http') ? domain : `https://${domain}`;
  const d = await getJson(`${base}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }).toString(),
  });
  sfToken = { token: d.access_token, instance: d.instance_url, expires: Date.now() + 50 * 60_000 };
  return sfToken;
}

export async function salesforceUpsert(s: Settings, object: string, matchField: string, matchValue: string, fields: FieldMap[]): Promise<Hit> {
  if (!/^[A-Za-z0-9_]+$/.test(object) || !/^[A-Za-z0-9_]+$/.test(matchField)) throw new Error('Invalid Salesforce object or field name');
  const { token, instance } = await salesforceAuth(s);
  const headers = { authorization: `Bearer ${token}` };
  const base = `${instance}/services/data/v62.0`;
  const body = { ...props(fields), ...(matchValue ? { [matchField]: matchValue } : {}) };
  let id: string | undefined;
  if (matchValue) {
    const soql = `SELECT Id FROM ${object} WHERE ${matchField} = '${matchValue.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}' LIMIT 1`;
    const q = await getJson(`${base}/query`, { headers, query: { q: soql } });
    id = q.records?.[0]?.Id;
  }
  if (id) {
    const res = await request(`${base}/sobjects/${object}/${id}`, { method: 'PATCH', headers, json: body });
    if (!res.ok) throw new Error(`Salesforce ${res.status}: ${await res.text()}`);
    return { value: id, data: { new: false, url: `${instance}/${id}` } };
  }
  const d = await getJson(`${base}/sobjects/${object}`, { method: 'POST', headers, json: body });
  return { value: d.id, data: { new: true, url: `${instance}/${d.id}` } };
}

// ---------- Prospect sources ----------
export async function apolloPeopleSearch(s: Settings, q: { titles?: string; domains?: string; locations?: string; seniorities?: string; limit: number }): Promise<Record<string, unknown>[]> {
  const key = s.get('APOLLO_API_KEY');
  if (!key) throw new Error('Set APOLLO_API_KEY');
  const list = (v?: string) => (v ? v.split(',').map((x) => x.trim()).filter(Boolean) : undefined);
  const out: Record<string, unknown>[] = [];
  for (let page = 1; out.length < q.limit && page <= 20; page++) {
    const d = await getJson('https://api.apollo.io/api/v1/mixed_people/api_search', {
      method: 'POST', headers: { 'x-api-key': key },
      json: { person_titles: list(q.titles), q_organization_domains_list: list(q.domains), person_locations: list(q.locations), person_seniorities: list(q.seniorities), page, per_page: Math.min(100, q.limit) },
    });
    const people = d.people ?? [];
    for (const p of people) {
      out.push({ 'First name': p.first_name, 'Last name': p.last_name ?? p.last_name_obfuscated, 'Full name': p.name, Title: p.title, Company: p.organization?.name, 'Company domain': p.organization?.primary_domain ?? p.organization?.website_url, 'LinkedIn URL': p.linkedin_url, Location: [p.city, p.state, p.country].filter(Boolean).join(', '), 'Apollo ID': p.id });
    }
    if (people.length === 0) break;
  }
  return out.slice(0, q.limit);
}

export async function apolloCompanySearch(s: Settings, q: { keywords?: string; locations?: string; employees?: string; limit: number }): Promise<Record<string, unknown>[]> {
  const key = s.get('APOLLO_API_KEY');
  if (!key) throw new Error('Set APOLLO_API_KEY');
  const list = (v?: string) => (v ? v.split(',').map((x) => x.trim()).filter(Boolean) : undefined);
  const out: Record<string, unknown>[] = [];
  for (let page = 1; out.length < q.limit && page <= 20; page++) {
    const d = await getJson('https://api.apollo.io/api/v1/mixed_companies/search', {
      method: 'POST', headers: { 'x-api-key': key },
      json: { q_organization_keyword_tags: list(q.keywords), organization_locations: list(q.locations), organization_num_employees_ranges: list(q.employees)?.map((r) => r.replace('-', ',')), page, per_page: Math.min(100, q.limit) },
    });
    const orgs = [...(d.organizations ?? []), ...(d.accounts ?? [])];
    for (const o of orgs) out.push({ Company: o.name, 'Company domain': o.primary_domain, 'LinkedIn URL': o.linkedin_url, Employees: o.estimated_num_employees, Industry: o.industry, Location: [o.city, o.state, o.country].filter(Boolean).join(', ') });
    if (!orgs.length) break;
  }
  return out.slice(0, q.limit);
}
