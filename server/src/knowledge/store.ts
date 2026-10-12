/**
 * Knowledge Hub: one structured record per workspace describing what the business
 * sells and to whom, plus free-form source docs. `knowledgeContext` turns it into a
 * compact text block for prompts (the agent, AI research columns, anything else).
 */
import { z } from 'zod';
import { nowIso, type Db } from '../db/db.ts';

const str = z.string().max(20_000).default('');
const list = z.array(z.string().max(500)).max(100).default([]);

export const hubSchema = z.object({
  company: z.object({ name: str, website: str, overview: str }).default({ name: '', website: '', overview: '' }),
  offers: z.array(z.object({ name: str, description: str, pricing: str })).max(50).default([]),
  icp: z.object({ industries: list, sizes: list, geos: list, tech: list, triggers: list, notes: str })
    .default({ industries: [], sizes: [], geos: [], tech: [], triggers: [], notes: '' }),
  personas: z.array(z.object({ title: str, pains: str, goals: str, objections: str })).max(50).default([]),
  positioning: str,
  competitors: z.array(z.object({ name: str, domain: str, notes: str })).max(50).default([]),
  proof: z.array(z.object({ title: str, summary: str, url: str })).max(50).default([]),
  tone: str,
  exclusions: str,
});
export type Hub = z.infer<typeof hubSchema>;

/** Same shape, every field optional: a PUT replaces only the sections (and company/ICP fields) it sends. */
const pstr = z.string().max(20_000).optional();
const plist = z.array(z.string().max(500)).max(100).optional();
export const hubPatchSchema = z.object({
  company: z.object({ name: pstr, website: pstr, overview: pstr }).optional(),
  offers: hubSchema.shape.offers.unwrap().optional(),
  icp: z.object({ industries: plist, sizes: plist, geos: plist, tech: plist, triggers: plist, notes: pstr }).optional(),
  personas: hubSchema.shape.personas.unwrap().optional(),
  positioning: pstr,
  competitors: hubSchema.shape.competitors.unwrap().optional(),
  proof: hubSchema.shape.proof.unwrap().optional(),
  tone: pstr,
  exclusions: pstr,
});
export type HubPatch = z.infer<typeof hubPatchSchema>;

export const SECTIONS = ['company', 'offers', 'icp', 'personas', 'positioning', 'competitors', 'proof', 'tone', 'exclusions'] as const;

export function emptyHub(): Hub {
  return hubSchema.parse({});
}

export function getHub(db: Db, workspaceId: number): Hub & { updated_at: string | null } {
  const row = db.get<{ data: string; updated_at: string }>('SELECT data, updated_at FROM knowledge_hub WHERE workspace_id = ?', [workspaceId]);
  let data: unknown = {};
  try { data = row ? JSON.parse(row.data) : {}; } catch { /* corrupt: start over */ }
  const parsed = hubSchema.safeParse(data);
  return { ...(parsed.success ? parsed.data : emptyHub()), updated_at: row?.updated_at ?? null };
}

export function saveHub(db: Db, workspaceId: number, patch: HubPatch): Hub {
  const { updated_at: _u, ...cur } = getHub(db, workspaceId);
  const next: Hub = hubSchema.parse({
    ...cur,
    ...patch,
    company: { ...cur.company, ...(patch.company ?? {}) },
    icp: { ...cur.icp, ...(patch.icp ?? {}) },
  });
  db.run(`INSERT INTO knowledge_hub (workspace_id, data, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(workspace_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`, [workspaceId, JSON.stringify(next), nowIso()]);
  return next;
}

/** Fills only what's empty — AI drafts never overwrite what the user wrote. */
export function mergeDraft(cur: Hub, draft: HubPatch): HubPatch {
  const out: HubPatch = {};
  const fill = (a: string, b?: string) => (a?.trim() ? a : b ?? a);
  if (draft.company) out.company = { name: fill(cur.company.name, draft.company.name), website: fill(cur.company.website, draft.company.website), overview: fill(cur.company.overview, draft.company.overview) };
  if (draft.icp) {
    const l = (k: 'industries' | 'sizes' | 'geos' | 'tech' | 'triggers') => (cur.icp[k].length ? cur.icp[k] : draft.icp?.[k] ?? []);
    out.icp = { industries: l('industries'), sizes: l('sizes'), geos: l('geos'), tech: l('tech'), triggers: l('triggers'), notes: fill(cur.icp.notes, draft.icp.notes) };
  }
  for (const k of ['offers', 'personas', 'competitors', 'proof'] as const) {
    if (draft[k]?.length && !cur[k].length) (out as any)[k] = draft[k];
  }
  for (const k of ['positioning', 'tone', 'exclusions'] as const) {
    if (draft[k] && !cur[k].trim()) out[k] = draft[k];
  }
  return out;
}

export function isEmptyHub(h: Hub): boolean {
  return !h.company.name && !h.company.overview && !h.offers.length && !h.personas.length && !h.positioning && !h.icp.industries.length && !h.icp.notes && !h.tone && !h.exclusions && !h.competitors.length && !h.proof.length;
}

const join = (xs: string[]) => xs.filter(Boolean).join(', ');
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const one = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Compact plain-text summary for prompts. Empty string when nothing is filled in. */
export function hubText(h: Hub, docs: { title: string; summary: string | null }[] = [], maxChars = 4000): string {
  const out: string[] = [];
  const c = h.company;
  if (c.name || c.overview) out.push(`Company: ${c.name || '(unnamed)'}${c.website ? ` (${c.website})` : ''}${c.overview ? ` — ${clip(one(c.overview), 600)}` : ''}`);
  if (h.offers.length) out.push(`Offers:\n${h.offers.map((o) => `- ${o.name}${o.description ? `: ${clip(one(o.description), 300)}` : ''}${o.pricing ? ` (pricing: ${one(o.pricing)})` : ''}`).join('\n')}`);
  const icp = h.icp;
  const icpBits = [
    icp.industries.length && `industries: ${join(icp.industries)}`, icp.sizes.length && `company sizes: ${join(icp.sizes)}`,
    icp.geos.length && `geos: ${join(icp.geos)}`, icp.tech.length && `tech: ${join(icp.tech)}`,
    icp.triggers.length && `buying triggers: ${join(icp.triggers)}`, icp.notes && clip(one(icp.notes), 400),
  ].filter(Boolean);
  if (icpBits.length) out.push(`ICP: ${icpBits.join('; ')}`);
  if (h.personas.length) out.push(`Buyer personas:\n${h.personas.map((p) => `- ${p.title}${p.pains ? ` — pains: ${clip(one(p.pains), 200)}` : ''}${p.goals ? `; goals: ${clip(one(p.goals), 200)}` : ''}${p.objections ? `; objections: ${clip(one(p.objections), 200)}` : ''}`).join('\n')}`);
  if (h.positioning) out.push(`Positioning / value props: ${clip(one(h.positioning), 700)}`);
  if (h.competitors.length) out.push(`Competitors: ${h.competitors.map((x) => `${x.name}${x.notes ? ` (${clip(one(x.notes), 120)})` : ''}`).join('; ')}`);
  if (h.proof.length) out.push(`Proof / case studies:\n${h.proof.map((p) => `- ${p.title}${p.summary ? `: ${clip(one(p.summary), 250)}` : ''}`).join('\n')}`);
  if (h.tone) out.push(`Tone of voice & email guidelines: ${clip(one(h.tone), 600)}`);
  if (h.exclusions) out.push(`Do NOT target: ${clip(one(h.exclusions), 400)}`);
  const withSummary = docs.filter((d) => d.summary);
  if (withSummary.length) out.push(`Notes from docs:\n${withSummary.slice(0, 8).map((d) => `- ${d.title}: ${clip(one(d.summary!), 300)}`).join('\n')}`);
  return clip(out.join('\n'), maxChars);
}

/** The workspace's Knowledge Hub as compact prompt text ('' when empty). For any module. */
export function knowledgeContext(ctx: { db: Db }, workspaceId: number, maxChars = 4000): string {
  try {
    const docs = ctx.db.all<{ title: string; summary: string | null }>('SELECT title, summary FROM knowledge_docs WHERE workspace_id = ? ORDER BY id DESC LIMIT 20', [workspaceId]);
    return hubText(getHub(ctx.db, workspaceId), docs, maxChars);
  } catch {
    return ''; // e.g. migrations not applied in a unit-test DB
  }
}
