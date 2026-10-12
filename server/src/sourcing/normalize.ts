/**
 * Normalising identifiers (domains, emails, company names, LinkedIn URLs, place ids)
 * and reading them out of loosely-named row objects. Shared by exclusions and the
 * dedupe keys of saved searches.
 */
import { createHash } from 'node:crypto';
import { toDomain } from '../gtm/lib/sandbox.ts';

export type IdKind = 'domain' | 'email' | 'company' | 'linkedin' | 'place';
export const ID_KINDS: IdKind[] = ['domain', 'email', 'company', 'linkedin', 'place'];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Sites a business listing links to that are not the business's own domain.
const NOT_OWN_SITE = /(^|\.)(facebook|instagram|linkedin|twitter|x|tiktok|youtube|yelp|tripadvisor|google|goo|wa|whatsapp|linktr|booksy|treatwell|opentable|ubereats|deliveroo|doordash|grubhub|wix|wixsite|sites\.google|business\.site|square\.site|godaddysites|weebly|blogspot|wordpress|calendly|bit|t)\.[a-z.]+$/i;

export function normDomain(v: unknown): string {
  const d = toDomain(String(v ?? '').trim()).replace(/\.$/, '');
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(d) ? d.toLowerCase() : '';
}

/** The business's own domain from a website URL; blank for social/listing sites. */
export function ownDomain(website: unknown): string {
  const d = normDomain(website);
  return d && !NOT_OWN_SITE.test(d) ? d : '';
}

export function normEmail(v: unknown): string {
  const e = String(v ?? '').trim().toLowerCase().replace(/^mailto:/, '');
  return EMAIL_RE.test(e) ? e : '';
}

const LEGAL = /\b(incorporated|inc|corp|corporation|co|company|llc|l\.l\.c|ltd|limited|plc|gmbh|ag|sa|sas|sarl|bv|nv|oy|ab|as|aps|srl|spa|pty|pte|kk|llp|lp|group|holdings?)\b\.?/g;

/** "Acme, Inc." → "acme"; accents, punctuation and legal suffixes dropped. */
export function normCompany(v: unknown): string {
  const s = String(v ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ');
  const stripped = s.replace(LEGAL, ' ').replace(/\s+/g, ' ').trim();
  return stripped || s.trim();
}

/** linkedin.com/in/<slug> or linkedin.com/company/<slug>, lowercased, no locale/query. */
export function normLinkedin(v: unknown): string {
  const m = String(v ?? '').trim().match(/linkedin\.com\/(in|pub|company|school)\/([^/?#\s]+)/i);
  return m ? `linkedin.com/${m[1].toLowerCase() === 'pub' ? 'in' : m[1].toLowerCase()}/${decodeURIComponent(m[2]).toLowerCase()}` : '';
}

export function normPlace(v: unknown): string {
  return String(v ?? '').trim().replace(/^places\//, '');
}

export function normalize(kind: IdKind, v: unknown): string {
  switch (kind) {
    case 'domain': return normDomain(v);
    case 'email': return normEmail(v);
    case 'company': return normCompany(v);
    case 'linkedin': return normLinkedin(v);
    case 'place': return normPlace(v);
  }
}

/** Guess what a pasted value is. */
export function detectKind(v: string): IdKind | null {
  const s = v.trim();
  if (!s) return null;
  if (/linkedin\.com\//i.test(s)) return 'linkedin';
  if (s.includes('@') && normEmail(s)) return 'email';
  if (/^(ChIJ|places\/|osm:|node\/|way\/|relation\/)/.test(s)) return 'place';
  if (!/\s/.test(s) && normDomain(s) && /\.[a-z]{2,}$/i.test(toDomain(s))) return 'domain';
  return 'company';
}

// Column names (lowercased) that carry each identifier, best first.
const FIELDS: Record<IdKind, string[]> = {
  place: ['place id', 'place_id', 'placeid', 'osm id', 'osm_id', 'google place id'],
  linkedin: ['linkedin url', 'linkedin', 'linkedin_url', 'person linkedin', 'company linkedin', 'linkedin profile'],
  email: ['email', 'work email', 'email address', 'e-mail', 'email_address'],
  domain: ['company domain', 'domain', 'website', 'company website', 'url', 'company_domain', 'website url'],
  company: ['company', 'company name', 'organization', 'organisation', 'account', 'company_name', 'name'],
};

/** Identifiers found in a row (`{ "Company domain": "acme.com", Email: … }`), normalised. */
export function rowIds(row: Record<string, unknown>): Partial<Record<IdKind, string>> {
  const lower = new Map(Object.entries(row).map(([k, v]) => [k.trim().toLowerCase(), headline(v)]));
  const out: Partial<Record<IdKind, string>> = {};
  for (const kind of ID_KINDS) {
    for (const f of FIELDS[kind]) {
      const raw = lower.get(f);
      if (raw == null || raw === '') continue;
      // "Name" is only a company name when the row has no person columns.
      if (kind === 'company' && f === 'name' && (lower.has('title') || lower.has('full name') || lower.has('first name'))) continue;
      const n = kind === 'domain' && /website|url/.test(f) ? ownDomain(raw) : normalize(kind, raw);
      if (n) { out[kind] = n; break; }
    }
  }
  // A work email implies the company domain.
  if (!out.domain && out.email && !FREEMAIL.has(out.email.split('@')[1])) out.domain = out.email.split('@')[1];
  return out;
}

/** The plain value of a table cell (enrichment cells are `{ value, … }`). */
function headline(v: unknown): string {
  if (v && typeof v === 'object' && !Array.isArray(v) && 'value' in (v as any)) return headline((v as any).value);
  return v == null ? '' : String(v).trim();
}

export type SourceShape = 'company' | 'person' | 'job' | 'place';

/**
 * The dedupe key a saved search uses for a row. Places dedupe by place/OSM id,
 * people by LinkedIn/email, companies by domain; anything else by a name+city hash.
 */
export function dedupeKey(row: Record<string, unknown>, shape: SourceShape): string {
  const ids = rowIds(row);
  const get = (k: string) => {
    for (const [name, v] of Object.entries(row)) if (name.trim().toLowerCase() === k) return headline(v);
    return '';
  };
  if (shape === 'job') {
    const url = get('job url');
    if (url) return `job:${url.toLowerCase()}`;
    return `hash:${hash([ids.domain ?? get('company'), get('job title'), get('location')])}`;
  }
  if (ids.place) return `place:${ids.place}`;
  if (shape === 'person') {
    if (ids.linkedin) return `li:${ids.linkedin}`;
    if (ids.email) return `email:${ids.email}`;
    const github = get('github');
    if (github) return `gh:${github.toLowerCase()}`;
    return `hash:${hash([get('full name') || `${get('first name')} ${get('last name')}`, ids.company ?? ids.domain ?? '', get('title')])}`;
  }
  if (shape === 'company' && ids.domain) return `domain:${ids.domain}`;
  if (ids.linkedin) return `li:${ids.linkedin}`;
  if (ids.domain && shape !== 'place') return `domain:${ids.domain}`;
  return `hash:${hash([ids.company ?? get('name'), get('city') || get('address') || get('location')])}`;
}

function hash(parts: string[]): string {
  return createHash('sha1').update(parts.map((p) => normCompany(p)).join('|')).digest('hex').slice(0, 16);
}

const FREEMAIL = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'live.com', 'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'gmx.de', 'web.de', 'yandex.com', 'mail.com', 'zoho.com', 'msn.com', 'yahoo.co.uk', 'hotmail.co.uk', 'btinternet.com', 'orange.fr', 'free.fr']);
export const isFreemail = (domain: string) => FREEMAIL.has(domain);
