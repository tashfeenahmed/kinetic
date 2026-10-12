/**
 * Knowledge Hub: plain markdown documents per workspace (company overview, ICP,
 * personas, tone…), written by the user, the agent or "fill from website".
 * `knowledgeContext` turns them into a compact text block for prompts (the agent,
 * AI research columns, AI reply drafts) — pinned docs first, then the user's order.
 * Docs can live in nested folders (see folders.ts).
 */
import { nowIso, type Db } from '../db/db.ts';
import { folderPaths, listFolders, PATH_SEP, topPosition, walkTree } from './folders.ts';

export type DocSource = 'user' | 'agent' | 'autofill';

export interface KnowledgeDoc {
  id: number;
  workspace_id: number;
  title: string;
  source_url: string | null;
  content: string;
  summary: string | null;
  position: number;
  pinned: number;
  created_by: DocSource;
  folder_id: number | null;
  created_at: string;
  updated_at: string;
}

const ORDER = 'pinned DESC, position ASC, id DESC';

export function listDocs(db: Db, workspaceId: number, q = ''): KnowledgeDoc[] {
  const docs = db.all<KnowledgeDoc>(`SELECT * FROM knowledge_docs WHERE workspace_id = ? ORDER BY ${ORDER}`, [workspaceId]);
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return docs;
  return docs.filter((d) => { const hay = `${d.title}\n${d.content}`.toLowerCase(); return terms.every((t) => hay.includes(t)); });
}

export function getDoc(db: Db, workspaceId: number, id: number): KnowledgeDoc | undefined {
  return db.get<KnowledgeDoc>('SELECT * FROM knowledge_docs WHERE id = ? AND workspace_id = ?', [id, workspaceId]);
}

/** By id, exact title (case-insensitive), then title prefix/substring. */
export function findDoc(db: Db, workspaceId: number, ref: string | number): KnowledgeDoc | undefined {
  const s = String(ref).trim();
  if (/^\d+$/.test(s)) { const d = getDoc(db, workspaceId, Number(s)); if (d) return d; }
  const docs = listDocs(db, workspaceId);
  const l = s.toLowerCase().replace(/^#/, '');
  if (l.includes('/')) {
    // "Folder / Doc title"
    const paths = folderPaths(listFolders(db, workspaceId));
    const norm = (x: string) => x.toLowerCase().split('/').map((p) => p.trim()).filter(Boolean).join('/');
    const want = norm(l);
    const hit = docs.find((d) => norm(`${d.folder_id ? `${paths.get(d.folder_id) ?? ''}/` : ''}${d.title}`) === want);
    if (hit) return hit;
  }
  return docs.find((d) => d.title.toLowerCase() === l) ?? docs.find((d) => d.title.toLowerCase().startsWith(l)) ?? docs.find((d) => d.title.toLowerCase().includes(l));
}

export function createDoc(db: Db, workspaceId: number, d: { title?: string; content?: string; source_url?: string | null; pinned?: boolean; created_by?: DocSource; folder_id?: number | null }): KnowledgeDoc {
  const now = nowIso();
  // New docs go to the top of their folder (or of the top level). The caller checks the folder.
  const folder = d.folder_id ?? null;
  const content = d.content ?? '';
  const id = db.insert('knowledge_docs', {
    workspace_id: workspaceId, title: d.title?.trim() || titleFrom(content), source_url: d.source_url ?? null, content, summary: null, folder_id: folder,
    position: topPosition(db, workspaceId, folder), pinned: d.pinned ? 1 : 0, created_by: d.created_by ?? 'user', created_at: now, updated_at: now,
  });
  return getDoc(db, workspaceId, id)!;
}

/** First heading or line of the markdown, else "Untitled". */
export function titleFrom(content: string): string {
  const line = content.split('\n').map((l) => l.replace(/^#+\s*|^[-*>]\s+/, '').trim()).find(Boolean);
  return line ? line.slice(0, 80) : 'Untitled';
}

/**
 * Reorders docs within their folders: the listed ids come first, in the given order, and
 * docs not listed keep their relative order after them. Docs swap places among the slots
 * their folder's docs already hold, so subfolders stay where they are.
 */
export function reorderDocs(db: Db, workspaceId: number, ids: number[]) {
  const all = listDocs(db, workspaceId);
  const known = new Set(all.map((d) => d.id));
  const rank = new Map([...ids.filter((id) => known.has(id)), ...all.map((d) => d.id).filter((id) => !ids.includes(id))].map((id, i) => [id, i]));
  db.tx(() => {
    // Normalise each folder to distinct 0..n slots first (folders included), then permute the doc slots.
    const count = new Map<number | null, number>();
    const slots = new Map<number | null, { doc: number; pos: number }[]>();
    for (const it of walkTree(db, workspaceId)) {
      const n = count.get(it.parent_id) ?? 0;
      count.set(it.parent_id, n + 1);
      db.run(`UPDATE ${it.type === 'doc' ? 'knowledge_docs' : 'knowledge_folders'} SET position = ? WHERE id = ? AND workspace_id = ?`, [n, it.id, workspaceId]);
      if (it.type === 'doc') slots.set(it.parent_id, [...(slots.get(it.parent_id) ?? []), { doc: it.id, pos: n }]);
    }
    for (const list of slots.values()) {
      const positions = list.map((x) => x.pos);
      [...list].sort((a, b) => rank.get(a.doc)! - rank.get(b.doc)!)
        .forEach((x, i) => db.run('UPDATE knowledge_docs SET position = ? WHERE id = ? AND workspace_id = ?', [positions[i], x.doc, workspaceId]));
    }
  });
}

/** Docs in tree order (depth first) with their folder path ('' at the top level). */
export function docsInTreeOrder(db: Db, workspaceId: number): (KnowledgeDoc & { path: string })[] {
  const docs = new Map(listDocs(db, workspaceId).map((d) => [d.id, d]));
  const paths = folderPaths(listFolders(db, workspaceId));
  return walkTree(db, workspaceId).filter((it) => it.type === 'doc' && docs.has(it.id))
    .map((it) => { const d = docs.get(it.id)!; return { ...d, path: d.folder_id ? paths.get(d.folder_id) ?? '' : '' }; });
}

/** "Folder / Sub / Title" (just the title at the top level). */
export const pathTitle = (d: { title: string; path: string }) => (d.path ? `${d.path}${PATH_SEP}${d.title}` : d.title);

/** Starter documents: just markdown with headings and prompts to fill in. */
export const TEMPLATES: { key: string; title: string; content: string }[] = [
  { key: 'company', title: 'Company overview', content: '## What we do\n\nOne or two sentences: what you sell and the outcome it gives customers.\n\n## Who it is for\n\n- \n\n## Products & pricing\n\n- **Product** — what it does, price\n\n## Key facts\n\n- Founded, team size, HQ, notable customers\n' },
  { key: 'icp', title: 'Ideal customer profile', content: '## Firmographics\n\n- **Industries:** \n- **Company size:** \n- **Geographies:** \n- **Tech they use:** \n\n## Buying triggers\n\n- Events that make a company likely to buy now (hiring, funding, new location…)\n\n## Good fit signals\n\n- \n\n## Bad fit signals\n\n- \n' },
  { key: 'personas', title: 'Buyer personas', content: '## Persona: Title / role\n\n**Pains:** \n\n**Goals:** \n\n**Objections:** \n\n**What they care about in an email:** \n' },
  { key: 'positioning', title: 'Positioning & messaging', content: '## One-liner\n\n\n\n## Value propositions\n\n1. \n2. \n3. \n\n## Differentiators\n\n- Why customers pick us over the alternatives\n' },
  { key: 'competitors', title: 'Competitors', content: '## Competitor name (domain.com)\n\n- **Where they win:** \n- **Where we win:** \n- **How to position against them:** \n' },
  { key: 'proof', title: 'Case studies', content: '## Customer name\n\n**Problem:** \n\n**What we did:** \n\n**Result:** a concrete number (e.g. cut lunch queues by 30%)\n\n[Link to the case study](https://)\n' },
  { key: 'tone', title: 'Tone of voice', content: '## How we sound\n\n- Friendly and direct, no buzzwords\n\n## Cold email rules\n\n- Under 90 words\n- One clear question as the call to action\n- Sign off with first name only\n\n## Words we avoid\n\n- \n' },
  { key: 'exclusions', title: 'Do-not-target list', content: '## Never contact\n\n- Existing customers\n- Competitors\n- \n\n## Out of scope\n\n- Company types, sizes or regions we do not serve\n' },
];

const clipAt = (s: string, n: number) => {
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  const nl = cut.lastIndexOf('\n');
  return `${(nl > n * 0.6 ? cut.slice(0, nl) : cut).trimEnd()} …`;
};

/** Markdown kept readable but compact: no blank-line runs, trailing spaces or empty bullets. */
export function compactMarkdown(md: string): string {
  return md.replace(/\r/g, '').split('\n').map((l) => l.trimEnd()).filter((l) => !/^\s*([-*+]|\d+\.)(\s+\[[ xX]\])?\s*$/.test(l))
    .join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Compact prompt text from the docs ('' when there are none with content). Pinned docs
 * come first and get a bigger share; the rest split what's left. Docs that don't fit are
 * listed by title so the model knows to read them with the knowledge tool.
 */
export function docsText(docs: Pick<KnowledgeDoc, 'id' | 'title' | 'content' | 'pinned'>[], maxChars = 5000): string {
  const items = docs.map((d) => ({ ...d, body: compactMarkdown(d.content) })).filter((d) => d.body);
  if (!items.length) return '';
  const out: string[] = [];
  const skipped: string[] = [];
  const reserve = items.length > 1 ? 240 : 0; // for the "More docs" line
  let left = maxChars - reserve;
  items.forEach((d, i) => {
    const head = `### ${d.title} (doc #${d.id})\n`;
    const rest = items.length - i;
    const share = d.pinned ? Math.max(left * 0.6, Math.floor(left / rest)) : Math.floor(left / rest);
    const room = Math.min(share, left) - head.length - 2;
    if (room < 120) { skipped.push(`#${d.id} ${d.title}`); return; }
    const block = head + clipAt(d.body, room);
    out.push(block);
    left -= block.length + 2;
  });
  if (skipped.length) {
    const names: string[] = [];
    for (const s of skipped) if ([...names, s].join('; ').length <= reserve - 70) names.push(s);
    const more = skipped.length - names.length;
    out.push(`(More docs — read with the knowledge tool: ${names.join('; ')}${more ? `; +${more} more` : ''})`);
  }
  return clipAt(out.join('\n\n'), maxChars);
}

/**
 * The workspace's Knowledge Hub as compact prompt text ('' when empty). For any module.
 * Pinned docs first, then the sidebar's tree order; docs in folders are titled "Folder / Title".
 */
export function knowledgeContext(ctx: { db: Db }, workspaceId: number, maxChars = 5000): string {
  try {
    const docs = docsInTreeOrder(ctx.db, workspaceId).map((d) => ({ ...d, title: pathTitle(d) }));
    return docsText([...docs.filter((d) => d.pinned), ...docs.filter((d) => !d.pinned)], maxChars);
  } catch {
    return ''; // e.g. migrations not applied in a unit-test DB
  }
}

/** Matching lines (with their nearest heading) per doc, for search results. */
export function searchDocs(docs: KnowledgeDoc[], q: string, maxPerDoc = 6): { id: number; title: string; hits: string[] }[] {
  const terms = q.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
  if (!terms.length) return [];
  const out: { id: number; title: string; hits: string[]; score: number }[] = [];
  for (const d of docs) {
    let heading = '';
    const hits: string[] = [];
    let score = terms.filter((t) => d.title.toLowerCase().includes(t)).length * 3;
    for (const line of d.content.split('\n')) {
      if (/^#{1,6}\s/.test(line)) heading = line.replace(/^#+\s*/, '');
      const l = line.toLowerCase();
      const n = terms.filter((t) => l.includes(t)).length;
      if (n && line.trim()) { score += n; if (hits.length < maxPerDoc) hits.push(`${heading && !/^#/.test(line) ? `[${heading}] ` : ''}${line.trim().slice(0, 300)}`); }
    }
    if (score) out.push({ id: d.id, title: d.title, hits, score });
  }
  return out.sort((a, b) => b.score - a.score).map(({ score: _s, ...r }) => r);
}
