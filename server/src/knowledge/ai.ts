/**
 * "Fill from website" for the Knowledge Hub. Reads a few pages of the user's site
 * (home, about, product, pricing, customers), then asks the model to draft a set of
 * markdown documents in one forced tool call. Without an AI key it still drafts a
 * short "Company overview" doc from the page's own metadata.
 */
import { fetchPage, decode } from '../gtm/lib/html.ts';
import type { Settings } from '../gtm/settings.ts';
import { aiReady, chat, fnTool, agentModel } from '../agent/llm.ts';

/** The documents autofill can draft, in display order. */
export const DRAFT_DOCS: { key: string; title: string; hint: string }[] = [
  { key: 'company', title: 'Company overview', hint: 'what the company does, for whom, key facts (name, website, HQ, size if stated). A short intro paragraph then bullets.' },
  { key: 'offers', title: 'Products & offers', hint: 'one "## Product" section per product/plan with what it does and pricing if stated.' },
  { key: 'icp', title: 'Ideal customer profile', hint: 'bullets for industries, company sizes, geographies, tech they use, and a "## Buying triggers" list. Infer sensibly from the product.' },
  { key: 'personas', title: 'Buyer personas', hint: 'one "## Role" section per persona with **Pains:**, **Goals:**, **Objections:**.' },
  { key: 'positioning', title: 'Positioning & messaging', hint: 'a one-liner, then value propositions and differentiators as bullets.' },
  { key: 'competitors', title: 'Competitors', hint: 'bullets: **Name** (domain) — how they compare. Only competitors named or clearly implied.' },
  { key: 'proof', title: 'Case studies', hint: 'one "## Customer" section per case study, logo or metric, with results and a link if present.' },
  { key: 'tone', title: 'Tone of voice', hint: 'how the company sounds, plus suggested cold-email guidelines as bullets.' },
  { key: 'exclusions', title: 'Do-not-target list', hint: 'who they clearly do not serve. Leave empty unless the source says so.' },
];

const DRAFT_TOOL = fnTool('submit', 'Submit the drafted Knowledge Hub documents as markdown. Leave a document empty when the source gives nothing for it.', {
  ...Object.fromEntries(DRAFT_DOCS.map((d) => [d.key, { type: 'string', description: `"${d.title}" document (markdown): ${d.hint}` }])),
  summary: { type: 'string', description: 'a 2-3 sentence summary of the source text' },
}, ['company']);

export interface DraftDoc { key: string; title: string; content: string }
export interface Draft { docs: DraftDoc[]; summary: string; ai: boolean }

/** Drafts markdown docs from source text (a website crawl or pasted material). */
export async function draftFromText(settings: Settings, source: string, hint: { domain?: string; title?: string } = {}): Promise<Draft> {
  if (!aiReady(settings)) throw new Error('Set OPENROUTER_API_KEY on the Integrations page (or AI_BASE_URL for a local model) to draft with AI');
  const r = await chat(settings, {
    model: agentModel(settings),
    messages: [
      { role: 'system', content: 'You turn company material into a go-to-market knowledge base for outbound sales: a few short, well-structured markdown documents (## headings, bullet lists, **bold** labels; no top-level # title, the document already has one). Be factual: only use what the source supports, but infer a sensible ICP and personas from the product when the source implies them. Keep each document concise.' },
      { role: 'user', content: `${hint.domain ? `Company website: ${hint.domain}\n` : ''}${hint.title ? `Document: ${hint.title}\n` : ''}\nSOURCE:\n${source.slice(0, 40_000)}\n\nCall submit with the drafted documents.` },
    ],
    tools: [DRAFT_TOOL],
    tool_choice: { type: 'function', function: { name: 'submit' } },
    max_tokens: 5000,
  });
  const call = r.message.tool_calls?.find((c) => c.function.name === 'submit');
  let args: any = {};
  try { args = JSON.parse(call?.function.arguments || '{}'); } catch { /* bad json */ }
  if (!call) {
    // Some models answer in prose with a JSON block.
    const m = r.message.content.match(/\{[\s\S]*\}/);
    try { args = m ? JSON.parse(m[0]) : {}; } catch { args = {}; }
  }
  return { docs: cleanDraft(args), summary: typeof args.summary === 'string' ? args.summary.trim() : '', ai: true };
}

/** Model output -> non-empty markdown docs in display order. Lists/objects are flattened to bullets. */
export function cleanDraft(args: any): DraftDoc[] {
  const md = (v: unknown): string => {
    if (v == null) return '';
    if (typeof v === 'string') return v.replace(/^#\s+[^\n]*\n+/, '').trim();
    if (Array.isArray(v)) return v.map((x) => `- ${typeof x === 'string' ? x : Object.values(x ?? {}).filter(Boolean).join(' — ')}`).join('\n');
    if (typeof v === 'object') return Object.entries(v).filter(([, x]) => x).map(([k, x]) => `- **${k}:** ${Array.isArray(x) ? x.join(', ') : String(x)}`).join('\n');
    return String(v).trim();
  };
  return DRAFT_DOCS.map((d) => ({ key: d.key, title: d.title, content: md(args?.[d.key]) })).filter((d) => d.content);
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

/** Website -> drafted docs. Falls back to page metadata when no model is configured. */
export async function draftFromWebsite(settings: Settings, domain: string): Promise<Draft & { pages: string[]; host: string }> {
  const { pages } = await crawlSite(domain);
  const text = pages.map((p) => `## ${p.title || p.url}\nURL: ${p.url}\n${p.description ? `Description: ${p.description}\n` : ''}${p.text}`).join('\n\n');
  const host = new URL(pages[0].url).hostname.replace(/^www\./, '');
  if (!aiReady(settings)) {
    const name = (pages[0].title.split(/\s[|–—-]\s/)[0] || host).trim();
    const content = [`**Company:** ${name}`, `**Website:** ${host}`, pages[0].description ? `\n${pages[0].description}` : ''].join('\n').trim();
    return { docs: [{ key: 'company', title: 'Company overview', content }], summary: pages[0].description, ai: false, pages: pages.map((p) => p.url), host };
  }
  const d = await draftFromText(settings, text, { domain: host });
  return { ...d, pages: pages.map((p) => p.url), host };
}
