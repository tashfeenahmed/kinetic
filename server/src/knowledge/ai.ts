/**
 * "AI fill from website" and doc summarising for the Knowledge Hub. Reads a few
 * pages of the user's site (home, about, product, pricing, customers), then asks the
 * model to draft the hub sections in one forced tool call. Without an AI key it still
 * fills the company name, website and overview from the page's own metadata.
 */
import { fetchPage, decode } from '../gtm/lib/html.ts';
import type { Settings } from '../gtm/settings.ts';
import { aiReady, chat, fnTool, agentModel } from '../agent/llm.ts';
import { hubPatchSchema, type HubPatch } from './store.ts';

const S = { type: 'string' };
const L = { type: 'array', items: { type: 'string' } };
const DRAFT_TOOL = fnTool('submit', 'Submit the drafted Knowledge Hub sections. Leave a field empty when the source does not say.', {
  company: { type: 'object', properties: { name: S, website: S, overview: { type: 'string', description: '2-4 sentences: what the company does, for whom' } } },
  offers: { type: 'array', items: { type: 'object', properties: { name: S, description: S, pricing: S } } },
  icp: { type: 'object', properties: { industries: L, sizes: L, geos: L, tech: L, triggers: { ...L, description: 'events that make a company likely to buy now' }, notes: S } },
  personas: { type: 'array', items: { type: 'object', properties: { title: S, pains: S, goals: S, objections: S } } },
  positioning: { type: 'string', description: 'value propositions and differentiators, a short paragraph or bullet list' },
  competitors: { type: 'array', items: { type: 'object', properties: { name: S, domain: S, notes: S } } },
  proof: { type: 'array', items: { type: 'object', properties: { title: S, summary: S, url: S } }, description: 'case studies, customer logos, metrics' },
  tone: { type: 'string', description: 'tone of voice the company uses, and suggested cold-email guidelines' },
  exclusions: { type: 'string', description: 'who they clearly do not serve (only if stated)' },
  summary: { type: 'string', description: 'a 2-3 sentence summary of the source text' },
}, ['company']);

export interface Draft { draft: HubPatch; summary: string; ai: boolean }

/** Drafts hub sections from source text (a website crawl or a pasted doc). */
export async function draftFromText(settings: Settings, source: string, hint: { domain?: string; title?: string } = {}): Promise<Draft> {
  if (!aiReady(settings)) throw new Error('Set OPENROUTER_API_KEY on the Integrations page (or AI_BASE_URL for a local model) to draft with AI');
  const r = await chat(settings, {
    model: agentModel(settings),
    messages: [
      { role: 'system', content: 'You turn company material into a structured go-to-market knowledge base for outbound sales. Be factual: only use what the source supports, but infer sensible ICP and personas from the product when the source implies them. Keep each field concise.' },
      { role: 'user', content: `${hint.domain ? `Company website: ${hint.domain}\n` : ''}${hint.title ? `Document: ${hint.title}\n` : ''}\nSOURCE:\n${source.slice(0, 40_000)}\n\nCall submit with the drafted sections.` },
    ],
    tools: [DRAFT_TOOL],
    tool_choice: { type: 'function', function: { name: 'submit' } },
    max_tokens: 3000,
  });
  const call = r.message.tool_calls?.find((c) => c.function.name === 'submit');
  let args: any = {};
  try { args = JSON.parse(call?.function.arguments || '{}'); } catch { /* bad json */ }
  if (!call) {
    // Some models answer in prose with a JSON block.
    const m = r.message.content.match(/\{[\s\S]*\}/);
    try { args = m ? JSON.parse(m[0]) : {}; } catch { args = {}; }
  }
  const summary = typeof args.summary === 'string' ? args.summary : '';
  return { draft: cleanDraft(args), summary, ai: true };
}

/** Coerces model output into the patch shape, dropping anything malformed. */
export function cleanDraft(args: any): HubPatch {
  const s = (v: unknown) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v));
  const l = (v: unknown) => (Array.isArray(v) ? v.map(s).filter(Boolean) : typeof v === 'string' && v ? v.split(/,\s*/) : []);
  const objs = <K extends string>(v: unknown, keys: K[]) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object').map((x: any) => Object.fromEntries(keys.map((k) => [k, s(x[k])])) as Record<K, string>) : undefined);
  const raw = {
    company: args.company && typeof args.company === 'object' ? { name: s(args.company.name), website: s(args.company.website), overview: s(args.company.overview) } : undefined,
    offers: objs(args.offers, ['name', 'description', 'pricing'])?.filter((o) => o.name),
    icp: args.icp && typeof args.icp === 'object' ? { industries: l(args.icp.industries), sizes: l(args.icp.sizes), geos: l(args.icp.geos), tech: l(args.icp.tech), triggers: l(args.icp.triggers), notes: s(args.icp.notes) } : undefined,
    personas: objs(args.personas, ['title', 'pains', 'goals', 'objections'])?.filter((p) => p.title),
    positioning: args.positioning ? s(Array.isArray(args.positioning) ? args.positioning.join('\n') : args.positioning) : undefined,
    competitors: objs(args.competitors, ['name', 'domain', 'notes'])?.filter((c) => c.name),
    proof: objs(args.proof, ['title', 'summary', 'url'])?.filter((p) => p.title),
    tone: args.tone ? s(args.tone) : undefined,
    exclusions: args.exclusions ? s(args.exclusions) : undefined,
  };
  const r = hubPatchSchema.safeParse(JSON.parse(JSON.stringify(raw)));
  return r.success ? r.data : {};
}

const INTERESTING = /\/(about|company|product|products|platform|solutions?|features|pricing|customers|case-studies|case_studies|stories|why|use-cases|industries)(\/|$)/i;

/** Home page plus up to `extra` same-site pages that usually describe the offer. */
export async function crawlSite(domain: string, extra = 4): Promise<{ pages: { url: string; title: string; text: string; description: string }[] }> {
  const start = domain.includes('://') ? domain : `https://${domain.replace(/^\/+/, '')}`;
  const home = await fetchPage(start, 20_000);
  if (home.status >= 400) throw new Error(`${start} returned HTTP ${home.status}`);
  const base = new URL(home.url || start);
  const links = new Set<string>();
  for (const m of home.html.matchAll(/<a\s[^>]*href="([^"#]+)"/gi)) {
    try {
      const u = new URL(decode(m[1]), base);
      if (u.hostname.replace(/^www\./, '') !== base.hostname.replace(/^www\./, '')) continue;
      u.hash = ''; u.search = '';
      if (INTERESTING.test(u.pathname)) links.add(u.toString());
    } catch { /* bad href */ }
  }
  const meta = (html: string) => decode(html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i)?.[1] ?? html.match(/<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']*)["']/i)?.[1] ?? '');
  const pages = [{ url: home.url || start, title: home.title, text: home.text.slice(0, 8000), description: meta(home.html) }];
  for (const url of [...links].slice(0, extra)) {
    try {
      const p = await fetchPage(url, 15_000);
      if (p.status < 400) pages.push({ url: p.url || url, title: p.title, text: p.text.slice(0, 6000), description: meta(p.html) });
    } catch { /* skip page */ }
  }
  return { pages };
}

/** Website → draft sections. Falls back to page metadata when no model is configured. */
export async function draftFromWebsite(settings: Settings, domain: string): Promise<Draft & { pages: string[]; text: string }> {
  const { pages } = await crawlSite(domain);
  const text = pages.map((p) => `## ${p.title || p.url}\nURL: ${p.url}\n${p.description ? `Description: ${p.description}\n` : ''}${p.text}`).join('\n\n');
  const host = new URL(pages[0].url).hostname.replace(/^www\./, '');
  if (!aiReady(settings)) {
    const name = (pages[0].title.split(/\s[|–—-]\s/)[0] || host).trim();
    return { draft: { company: { name, website: host, overview: pages[0].description } }, summary: pages[0].description, ai: false, pages: pages.map((p) => p.url), text };
  }
  const d = await draftFromText(settings, text, { domain: host });
  d.draft.company = { ...d.draft.company, website: d.draft.company?.website || host };
  return { ...d, pages: pages.map((p) => p.url), text };
}
