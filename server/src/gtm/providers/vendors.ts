/**
 * Paid data vendors. Each function returns null when the vendor has no match
 * (so the waterfall moves on) and throws on transport/auth errors.
 * Bring your own keys; every vendor here has a free tier or pay-as-you-go plan.
 */
import { getJson, HttpError } from '../lib/http.ts';
import { toDomain } from '../lib/sandbox.ts';
import { nameParts, type Ctx, type EnrichInput, type Hit } from './types.ts';
import { useCredits, type CreditProvider } from './credits.ts';

/** Meter credits a vendor charged (only when it returned data). */
const spend = (ctx: Ctx, p: CreditProvider, n = 1) => useCredits(ctx.settings.db, p, n);

const notFound = (e: unknown) => e instanceof HttpError && (e.status === 404 || e.status === 422 && /not.?found|no.?match/i.test(e.message));

// ---------- Hunter (hunter.io) ----------
const hunterKey = (ctx: Ctx) => ctx.settings.get('HUNTER_API_KEY')!;

export async function hunterEmail(input: EnrichInput, ctx: Ctx): Promise<Hit | null> {
  const { first, last, full } = nameParts(input);
  const d = await getJson('https://api.hunter.io/v2/email-finder', {
    query: { domain: toDomain(input.domain), company: input.domain ? undefined : input.companyName, first_name: first, last_name: last, full_name: first ? undefined : full, linkedin_handle: linkedinHandle(input.linkedinUrl), api_key: hunterKey(ctx) },
  }).catch((e) => { if (notFound(e)) return null; throw e; });
  const email = d?.data?.email;
  if (!email) return null;
  spend(ctx, 'hunter');
  return { value: email, confidence: `${d.data.score ?? '?'}% · ${d.data.verification?.status ?? 'unverified'}`, data: d.data };
}

export async function hunterVerify(input: EnrichInput, ctx: Ctx): Promise<Hit | null> {
  const d = await getJson('https://api.hunter.io/v2/email-verifier', { query: { email: input.email, api_key: hunterKey(ctx) } });
  if (d?.data?.status) spend(ctx, 'hunter', 0.5);
  return d?.data?.status ? { value: normaliseStatus(d.data.status), data: d.data } : null;
}

export async function hunterCompany(input: EnrichInput, ctx: Ctx): Promise<Hit | null> {
  const d = await getJson('https://api.hunter.io/v2/companies/find', { query: { domain: toDomain(input.domain), api_key: hunterKey(ctx) } })
    .catch((e) => { if (notFound(e)) return null; throw e; });
  const c = d?.data;
  if (!c?.name) return null;
  spend(ctx, 'hunter');
  return { value: c.name, data: { name: c.name, domain: c.domain, description: c.description, industry: c.category?.industry, employees: c.metrics?.employees, location: c.location ?? c.geo?.city, founded: c.foundedYear, linkedin: c.linkedin?.handle ? `https://www.linkedin.com/${c.linkedin.handle}` : undefined, tech: c.tech, raw: c } };
}

// ---------- Apollo (apollo.io) ----------
const apolloHeaders = (ctx: Ctx) => ({ 'x-api-key': ctx.settings.get('APOLLO_API_KEY')!, 'cache-control': 'no-cache' });

export async function apolloPerson(input: EnrichInput, ctx: Ctx) {
  const { first, last, full } = nameParts(input);
  const d = await getJson('https://api.apollo.io/api/v1/people/match', {
    method: 'POST',
    headers: apolloHeaders(ctx),
    query: { first_name: first, last_name: last, name: first ? undefined : full, email: input.email, domain: toDomain(input.domain), organization_name: input.companyName, linkedin_url: input.linkedinUrl, reveal_personal_emails: 'false' },
  }).catch((e) => { if (notFound(e)) return null; throw e; });
  if (d?.person) spend(ctx, 'apollo');
  return d?.person ?? null;
}

export async function apolloEmail(input: EnrichInput, ctx: Ctx): Promise<Hit | null> {
  const p = await apolloPerson(input, ctx);
  if (!p?.email || /email_not_unlocked/.test(p.email)) return null;
  return { value: p.email, confidence: p.email_status, data: personShape(p) };
}

export async function apolloProfile(input: EnrichInput, ctx: Ctx): Promise<Hit | null> {
  const p = await apolloPerson(input, ctx);
  if (!p) return null;
  return { value: p.name, data: personShape(p) };
}

export async function apolloLinkedin(input: EnrichInput, ctx: Ctx): Promise<Hit | null> {
  const p = await apolloPerson(input, ctx);
  return p?.linkedin_url ? { value: p.linkedin_url, data: personShape(p) } : null;
}

export async function apolloCompany(input: EnrichInput, ctx: Ctx): Promise<Hit | null> {
  const d = await getJson('https://api.apollo.io/api/v1/organizations/enrich', { headers: apolloHeaders(ctx), query: { domain: toDomain(input.domain) } })
    .catch((e) => { if (notFound(e)) return null; throw e; });
  const o = d?.organization;
  if (!o?.name) return null;
  spend(ctx, 'apollo');
  return { value: o.name, data: { name: o.name, domain: o.primary_domain, description: o.short_description, industry: o.industry, employees: o.estimated_num_employees, location: [o.city, o.state, o.country].filter(Boolean).join(', '), founded: o.founded_year, linkedin: o.linkedin_url, revenue: o.annual_revenue_printed, funding: o.total_funding_printed, latestFunding: o.latest_funding_stage, tech: o.technology_names, raw: o } };
}

export async function apolloDomain(input: EnrichInput, ctx: Ctx): Promise<Hit | null> {
  const d = await getJson('https://api.apollo.io/api/v1/mixed_companies/search', { method: 'POST', headers: apolloHeaders(ctx), json: { q_organization_name: input.companyName, per_page: 1 } });
  const o = d?.organizations?.[0] ?? d?.accounts?.[0];
  return o?.primary_domain ? { value: o.primary_domain, data: { name: o.name, linkedin: o.linkedin_url } } : null;
}

function personShape(p: any) {
  const org = p.organization ?? {};
  return { name: p.name, title: p.title, email: p.email, emailStatus: p.email_status, linkedin: p.linkedin_url, location: [p.city, p.state, p.country].filter(Boolean).join(', '), company: org.name, companyDomain: org.primary_domain, seniority: p.seniority, departments: p.departments, employment: p.employment_history?.slice(0, 5), raw: p };
}

// ---------- People Data Labs ----------
const pdlHeaders = (ctx: Ctx) => ({ 'X-Api-Key': ctx.settings.get('PDL_API_KEY')! });

export async function pdlPerson(input: EnrichInput, ctx: Ctx) {
  const { first, last, full } = nameParts(input);
  const d = await getJson('https://api.peopledatalabs.com/v5/person/enrich', {
    headers: pdlHeaders(ctx),
    query: { first_name: first || undefined, last_name: last || undefined, name: first ? undefined : full || undefined, company: toDomain(input.domain) || input.companyName, profile: input.linkedinUrl, email: input.email, min_likelihood: 4, titlecase: 'true' },
  }).catch((e) => { if (notFound(e)) return null; throw e; });
  if (d?.data) spend(ctx, 'pdl');
  return d?.data ?? null;
}

export async function pdlEmail(input: EnrichInput, ctx: Ctx): Promise<Hit | null> {
  const p = await pdlPerson(input, ctx);
  const email = p?.work_email || (Array.isArray(p?.emails) ? p.emails.find((e: any) => e.type === 'professional')?.address : null);
  return email && typeof email === 'string' ? { value: email, data: pdlShape(p) } : null;
}

export async function pdlPhone(input: EnrichInput, ctx: Ctx): Promise<Hit | null> {
  const p = await pdlPerson(input, ctx);
  const phone = typeof p?.mobile_phone === 'string' ? p.mobile_phone : Array.isArray(p?.phone_numbers) ? p.phone_numbers.find((x: unknown) => typeof x === 'string') : null;
  return phone ? { value: phone, data: pdlShape(p) } : null;
}

export async function pdlProfile(input: EnrichInput, ctx: Ctx): Promise<Hit | null> {
  const p = await pdlPerson(input, ctx);
  return p ? { value: p.full_name, data: pdlShape(p) } : null;
}

export async function pdlLinkedin(input: EnrichInput, ctx: Ctx): Promise<Hit | null> {
  const p = await pdlPerson(input, ctx);
  return p?.linkedin_url ? { value: `https://${String(p.linkedin_url).replace(/^https?:\/\//, '')}`, data: pdlShape(p) } : null;
}

export async function pdlCompany(input: EnrichInput, ctx: Ctx): Promise<Hit | null> {
  const d = await getJson('https://api.peopledatalabs.com/v5/company/enrich', { headers: pdlHeaders(ctx), query: { website: toDomain(input.domain) || undefined, name: input.domain ? undefined : input.companyName, titlecase: 'true' } })
    .catch((e) => { if (notFound(e)) return null; throw e; });
  if (!d?.name) return null;
  spend(ctx, 'pdl');
  return { value: d.display_name ?? d.name, data: { name: d.display_name ?? d.name, domain: d.website, description: d.summary, industry: d.industry, employees: d.employee_count, size: d.size, location: d.location?.name, founded: d.founded, linkedin: d.linkedin_url ? `https://${d.linkedin_url}` : undefined, funding: d.total_funding_raised, latestFunding: d.latest_funding_stage, tags: d.tags, raw: d } };
}

function pdlShape(p: any) {
  return { name: p.full_name, title: p.job_title, company: p.job_company_name, companyDomain: p.job_company_website, linkedin: p.linkedin_url, location: p.location_name, jobStarted: p.job_start_date, jobLastChanged: p.job_last_changed ?? p.job_last_updated, workEmail: p.work_email, mobile: p.mobile_phone, raw: p };
}

// ---------- Prospeo ----------
export async function prospeoPerson(input: EnrichInput, ctx: Ctx, mobile: boolean) {
  const { first, last, full } = nameParts(input);
  const d = await getJson('https://api.prospeo.io/enrich-person', {
    method: 'POST',
    headers: { 'X-KEY': ctx.settings.get('PROSPEO_API_KEY')! },
    json: {
      only_verified_email: true,
      enrich_mobile: mobile,
      data: { first_name: first || undefined, last_name: last || undefined, full_name: first ? undefined : full || undefined, company_website: toDomain(input.domain) || undefined, company_name: input.companyName, linkedin_url: input.linkedinUrl, email: input.email },
    },
  }).catch((e) => { if (e instanceof HttpError && /NO_MATCH|not.?found/i.test(e.message)) return null; throw e; });
  // Prospeo charges 1 credit per email found (10 with a mobile) and nothing for a re-enrich within 90 days.
  if (d?.person && !d.free_enrichment) spend(ctx, 'prospeo', mobile && d.person.mobile?.revealed ? 10 : d.person.email?.revealed || d.person.email?.email ? 1 : 0);
  return d?.person ?? null;
}

export async function prospeoEmail(input: EnrichInput, ctx: Ctx): Promise<Hit | null> {
  const p = await prospeoPerson(input, ctx, false);
  const email = p?.email?.email ?? (typeof p?.email === 'string' ? p.email : null);
  return email ? { value: email, confidence: p.email?.status, data: p } : null;
}

export async function prospeoPhone(input: EnrichInput, ctx: Ctx): Promise<Hit | null> {
  const p = await prospeoPerson(input, ctx, true);
  const phone = p?.mobile?.mobile ?? p?.mobile?.number ?? (typeof p?.mobile === 'string' ? p.mobile : null);
  return phone ? { value: phone, data: p } : null;
}

// ---------- Findymail ----------
const findymailHeaders = (ctx: Ctx) => ({ authorization: `Bearer ${ctx.settings.get('FINDYMAIL_API_KEY')}`, accept: 'application/json' });

export async function findymailEmail(input: EnrichInput, ctx: Ctx): Promise<Hit | null> {
  const { full } = nameParts(input);
  const d = input.linkedinUrl && !full
    ? await getJson('https://app.findymail.com/api/search/linkedin', { method: 'POST', headers: findymailHeaders(ctx), json: { linkedin_url: input.linkedinUrl } })
    : await getJson('https://app.findymail.com/api/search/name', { method: 'POST', headers: findymailHeaders(ctx), json: { name: full, domain: toDomain(input.domain) || input.companyName } });
  const email = d?.contact?.email;
  return email ? { value: email, confidence: 'verified', data: d.contact } : null;
}

export async function findymailPhone(input: EnrichInput, ctx: Ctx): Promise<Hit | null> {
  if (!input.linkedinUrl) return null;
  const d = await getJson('https://app.findymail.com/api/search/phone', { method: 'POST', headers: findymailHeaders(ctx), json: { linkedin_url: input.linkedinUrl } });
  return d?.phone ? { value: d.phone, data: d } : null;
}

// ---------- LeadMagic ----------
const leadmagicHeaders = (ctx: Ctx) => ({ 'X-API-Key': ctx.settings.get('LEADMAGIC_API_KEY')! });

export async function leadmagicEmail(input: EnrichInput, ctx: Ctx): Promise<Hit | null> {
  const { first, last, full } = nameParts(input);
  const d = await getJson('https://api.leadmagic.io/email-finder', { method: 'POST', headers: leadmagicHeaders(ctx), json: { first_name: first, last_name: last, full_name: full, domain: toDomain(input.domain), company_name: input.companyName } });
  return d?.email && /valid/i.test(d.status ?? 'valid') ? { value: d.email, confidence: d.status, data: d } : null;
}

export async function leadmagicPhone(input: EnrichInput, ctx: Ctx): Promise<Hit | null> {
  if (!input.linkedinUrl && !input.email) return null;
  const d = await getJson('https://api.leadmagic.io/mobile-finder', { method: 'POST', headers: leadmagicHeaders(ctx), json: { profile_url: input.linkedinUrl, work_email: input.email } });
  const phone = d?.mobile_number ?? d?.mobile;
  return phone ? { value: phone, data: d } : null;
}

// ---------- Email verification ----------
export async function millionVerifier(input: EnrichInput, ctx: Ctx): Promise<Hit | null> {
  const d = await getJson('https://api.millionverifier.com/api/v3/', { query: { api: ctx.settings.get('MILLIONVERIFIER_API_KEY'), email: input.email, timeout: 20 } });
  return d?.result ? { value: normaliseStatus(d.result), data: d } : null;
}

export async function zeroBounce(input: EnrichInput, ctx: Ctx): Promise<Hit | null> {
  const d = await getJson('https://api.zerobounce.net/v2/validate', { query: { api_key: ctx.settings.get('ZEROBOUNCE_API_KEY'), email: input.email } });
  return d?.status ? { value: normaliseStatus(d.status), data: d } : null;
}

/** Map vendor verdicts onto valid | catch_all | invalid | risky | unknown. */
export function normaliseStatus(s: string): string {
  const v = s.toLowerCase();
  if (['valid', 'ok', 'deliverable'].includes(v)) return 'valid';
  if (['catch_all', 'catch-all', 'accept_all', 'acceptall'].includes(v)) return 'catch_all';
  if (['invalid', 'undeliverable', 'error', 'spamtrap', 'abuse', 'do_not_mail'].includes(v)) return 'invalid';
  if (['disposable', 'webmail', 'risky'].includes(v)) return 'risky';
  return 'unknown';
}

function linkedinHandle(url?: string) {
  return url?.match(/linkedin\.com\/in\/([^/?#]+)/i)?.[1];
}

// ---------- Icypeas (async search, polled) ----------
const ICYPEAS_PENDING = new Set(['NONE', 'SCHEDULED', 'IN_PROGRESS']);

export async function icypeasEmail(input: EnrichInput, ctx: Ctx): Promise<Hit | null> {
  const { first, last } = nameParts(input);
  const headers = { authorization: ctx.settings.get('ICYPEAS_API_KEY')! };
  const start = await getJson('https://app.icypeas.com/api/email-search', { method: 'POST', headers, json: { firstname: first, lastname: last, domainOrCompany: toDomain(input.domain) || input.companyName } });
  const id = start?.item?._id;
  if (!id) throw new Error(`Icypeas: ${JSON.stringify(start).slice(0, 200)}`);
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const d = await getJson('https://app.icypeas.com/api/bulk-single-searchs/read', { method: 'POST', headers, json: { id } });
    const item = d?.items?.[0];
    if (!item || ICYPEAS_PENDING.has(item.status)) continue;
    const email = item.results?.emails?.[0];
    return email?.email ? { value: email.email, confidence: email.certainty, data: item.results } : null;
  }
  throw new Error('Icypeas: timed out waiting for result');
}

/**
 * Cheapest high-accuracy path: generate the common patterns and ask
 * MillionVerifier (~$0.0004 each) which one is a real mailbox.
 */
export async function patternVerified(input: EnrichInput, ctx: Ctx, guess: (i: EnrichInput) => Promise<Hit | null>): Promise<Hit | null> {
  const g = await guess(input);
  const candidates = (g?.data?.candidates as string[] | undefined)?.slice(0, 3) ?? [];
  for (const email of candidates) {
    const v = await millionVerifier({ email }, ctx);
    if (v?.value === 'valid') return { value: email, confidence: 'verified (pattern)', data: { tried: candidates, verifier: v.data } };
    if (v?.value === 'catch_all') return null; // every pattern would "verify"; let real finders decide
  }
  return null;
}
