/**
 * Fit score: one small, deterministic AI call (temperature 0, strict JSON) that grades a
 * row 0–100 against the workspace's ideal customer profile and buyer personas from the
 * Knowledge Hub, with a tier and a one-sentence reason. Only relevant row fields are
 * sent, each truncated, so it stays cheap on free OpenRouter models or a local Ollama.
 */
import { chat } from '../../agent/llm.ts';
import { DEFAULT_MODEL } from '../engine/agent.ts';
import { compactMarkdown, docsInTreeOrder, pathTitle, TEMPLATES } from '../../knowledge/store.ts';
import type { Db } from '../../db/db.ts';
import type { Ctx, EnrichInput, Hit } from './types.ts';

export const NO_ICP = 'Add your ideal customer profile in the Knowledge Hub (an "Ideal customer profile" or "Buyer personas" doc) to score fit.';

const PROFILE_DOC = /ideal customer|\bicp\b|persona|target (market|customer|account)|who we sell/i;
const TEMPLATE_LINES = new Set(TEMPLATES.flatMap((t) => t.content.split('\n').map((l) => l.trim())));

/** The ICP + persona docs as prompt text ('' when none has real content beyond the starter template). */
export function icpText(db: Db, workspaceId: number, maxChars = 3000): { text: string; docs: string[] } {
  let docs: ReturnType<typeof docsInTreeOrder> = [];
  try { docs = docsInTreeOrder(db, workspaceId); } catch { /* no knowledge tables (unit-test DB) */ }
  const parts: string[] = [];
  const titles: string[] = [];
  for (const d of docs) {
    const title = pathTitle(d);
    if (!PROFILE_DOC.test(title)) continue;
    const body = compactMarkdown(d.content);
    const real = body.split('\n').some((l) => {
      const t = l.trim();
      return t && !TEMPLATE_LINES.has(t) && !/^#{1,6}\s/.test(t) && !/^([-*]\s*)?\*\*[^*]+:\*\*\s*$/.test(t);
    });
    if (!real) continue;
    parts.push(`### ${title}\n${body}`);
    titles.push(title);
  }
  const text = parts.join('\n\n');
  return { text: text.length > maxChars ? `${text.slice(0, maxChars)} …` : text, docs: titles };
}

const SKIP_FIELD = /e-?mail|phone|mobile|linkedin|url|status|push|alert|webhook|slack|→|fit score|^id$/i;
const RELEVANT_KEY = /industr|sector|categor|size|employ|headcount|revenue|location|country|city|region|description|summary|about|title|seniority|department|tech|funding|founded|keywords|icp|reason|count|stage|similar/i;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function flat(v: unknown, n = 300): string {
  if (v == null || v === '') return '';
  if (Array.isArray(v)) return clip(v.slice(0, 12).map((x) => flat(x, 80)).filter(Boolean).join(', '), n);
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    // Enrichment / signal / AI cells are {value, data}: keep the headline plus short, relevant details.
    if ('value' in o) {
      const head = o.value && typeof o.value === 'object' && !Array.isArray(o.value) ? '' : flat(o.value, n);
      const data = (o.data && typeof o.data === 'object' ? o.data : typeof o.value === 'object' ? o.value : {}) as Record<string, unknown>;
      const extra = Object.entries(data ?? {})
        .filter(([k, x]) => RELEVANT_KEY.test(k) && x != null && x !== '' && (typeof x !== 'object' || Array.isArray(x)))
        .map(([k, x]) => `${k}: ${flat(x, 120)}`);
      return clip([head, ...extra].filter(Boolean).join('; '), n);
    }
    return clip(Object.entries(o).filter(([, x]) => x != null && typeof x !== 'object').map(([k, x]) => `${k}: ${x}`).join('; '), n);
  }
  return clip(String(v).replace(/\s+/g, ' ').trim(), n);
}

/** Compact "- Field: value" lines: mapped inputs first, then other relevant row fields. */
export function rowFacts(input: EnrichInput, row: Record<string, unknown> = {}, maxChars = 2000): string {
  const lines: string[] = [];
  const seen = new Set<string>();
  const add = (k: string, v: unknown, n?: number) => {
    const s = flat(v, n);
    if (!s || seen.has(s)) return;
    seen.add(s);
    lines.push(`- ${k}: ${s}`);
  };
  add('Company', input.companyName);
  add('Website', input.domain);
  add('Person', input.fullName || [input.firstName, input.lastName].filter(Boolean).join(' '));
  add('Title', input.title);
  add('Context', input.context, 600);
  for (const [k, v] of Object.entries(row)) {
    if (k.startsWith('_') || SKIP_FIELD.test(k)) continue;
    if (typeof v === 'string' && /^https?:\/\//.test(v.trim())) continue;
    add(k, v);
    if (lines.length >= 30) break;
  }
  let out = '';
  for (const l of lines) { if (out.length + l.length > maxChars) break; out += `${l}\n`; }
  return out.trim();
}

const SYSTEM = `You score sales prospects against our ideal customer profile (ICP) and buyer personas.
Reply with strict JSON only, no prose: {"score": <integer 0-100>, "reason": "<one sentence, at most 25 words>"}
70-100 = clear match on most ICP criteria; 40-69 = partial match or key facts missing; 0-39 = clear mismatch or a bad-fit signal.
Judge only from the facts given. Do not invent facts. The reason names the deciding facts (and what is missing, if anything).`;

export const fitTier = (score: number) => (score >= 70 ? 'strong' : score >= 40 ? 'possible' : 'poor');

/** Pull {score, reason} out of a model answer (tolerates code fences or chatter around the JSON). */
export function parseFit(content: string): { score: number; reason: string } | null {
  const m = content.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    const n = Number(j.score);
    if (!Number.isFinite(n)) return null;
    return { score: Math.max(0, Math.min(100, Math.round(n))), reason: clip(String(j.reason ?? '').replace(/\s+/g, ' ').trim(), 240) };
  } catch {
    return null;
  }
}

export async function fitScore(input: EnrichInput, ctx: Ctx): Promise<Hit | null> {
  const icp = ctx.workspaceId ? icpText(ctx.settings.db, ctx.workspaceId) : { text: '', docs: [] };
  if (!icp.text) throw new Error(NO_ICP);
  const facts = rowFacts(input, ctx.row);
  if (!facts) return null;
  const model = ctx.settings.get('AI_MODEL') || DEFAULT_MODEL;
  const r = await chat(ctx.settings, {
    model, temperature: 0, max_tokens: 200,
    messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: `ICP and personas:\n${icp.text}\n\nProspect:\n${facts}` }],
  });
  const fit = parseFit(r.message.content);
  if (!fit) throw new Error(`Unreadable model answer: ${r.message.content.slice(0, 160)}`);
  const tier = fitTier(fit.score);
  return { value: fit.score, confidence: tier, data: { score: fit.score, tier, reason: fit.reason, icp_docs: icp.docs, model } };
}
