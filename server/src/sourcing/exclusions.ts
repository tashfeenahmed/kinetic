/**
 * Workspace exclusion lists: domains, emails, company names, LinkedIn URLs, place ids and phones
 * that sourcing never brings back (customers, competitors, do-not-contact, people already
 * in campaigns). Values are stored normalised in an indexed table, so lists of 300k+
 * entries insert in one batched transaction and lookups stay fast.
 *
 * Other modules: `filterExcluded(db, workspaceId, rows)` before adding rows,
 * `isExcluded(db, workspaceId, row)` for a single record.
 */
import type { StatementSync } from 'node:sqlite';
import { nowIso, type Db } from '../db/db.ts';
import { LIKE_ESCAPE, contains } from '../lib/like.ts';
import { detectKind, ID_KINDS, isFreemail, normalize, rowIds, type IdKind } from './normalize.ts';

export interface ExclusionList { id: number; workspace_id: number; name: string; created_at: string; updated_at: string }

export function listIn(db: Db, id: number, workspaceId: number): ExclusionList {
  const l = db.get<ExclusionList>('SELECT * FROM exclusion_lists WHERE id = ? AND workspace_id = ?', [id, workspaceId]);
  if (!l) throw Object.assign(new Error('Exclusion list not found'), { statusCode: 404 });
  return l;
}

export function createList(db: Db, workspaceId: number, name: string): number {
  const now = nowIso();
  return db.insert('exclusion_lists', { workspace_id: workspaceId, name, created_at: now, updated_at: now });
}

/** Lists with entry counts per kind. */
export function listSummaries(db: Db, workspaceId: number) {
  const lists = db.all<ExclusionList>('SELECT * FROM exclusion_lists WHERE workspace_id = ? ORDER BY name', [workspaceId]);
  const counts = db.all<{ list_id: number; kind: IdKind; n: number }>(
    'SELECT list_id, kind, COUNT(*) AS n FROM exclusion_entries WHERE workspace_id = ? GROUP BY list_id, kind', [workspaceId]);
  return lists.map((l) => {
    const byKind = Object.fromEntries(ID_KINDS.map((k) => [k, 0])) as Record<IdKind, number>;
    for (const c of counts) if (c.list_id === l.id) byKind[c.kind] = c.n;
    return { ...l, counts: byKind, total: Object.values(byKind).reduce((a, b) => a + b, 0) };
  });
}

/**
 * Add raw values (pasted lines, CSV cells). `kind` 'auto' detects each value's kind;
 * values that don't normalise are skipped. Batched: one transaction, one prepared statement.
 */
export function addValues(db: Db, workspaceId: number, listId: number, values: Iterable<string>, kind: IdKind | 'auto' = 'auto') {
  const entries: { kind: IdKind; value: string }[] = [];
  let skipped = 0;
  for (const raw of values) {
    const s = String(raw ?? '').trim();
    if (!s) continue;
    const k = kind === 'auto' ? detectKind(s) : kind;
    const v = k ? normalize(k, s) : '';
    if (k && v) entries.push({ kind: k, value: v }); else skipped++;
  }
  const added = addEntries(db, workspaceId, listId, entries);
  return { received: entries.length + skipped, added, duplicates: entries.length - added, skipped };
}

/** Insert already-normalised entries; returns how many were new. */
export function addEntries(db: Db, workspaceId: number, listId: number, entries: { kind: IdKind; value: string }[]): number {
  if (!entries.length) return 0;
  const stmt: StatementSync = db.raw.prepare('INSERT OR IGNORE INTO exclusion_entries (list_id, workspace_id, kind, value) VALUES (?, ?, ?, ?)');
  let added = 0;
  const CHUNK = 50_000; // keep each write transaction short so other writers aren't blocked for long
  for (let i = 0; i < entries.length; i += CHUNK) {
    db.tx(() => {
      for (const e of entries.slice(i, i + CHUNK)) added += Number(stmt.run(listId, workspaceId, e.kind, e.value).changes);
    });
  }
  db.run('UPDATE exclusion_lists SET updated_at = ? WHERE id = ?', [nowIso(), listId]);
  return added;
}

export function removeValues(db: Db, workspaceId: number, listId: number, values: string[], kind: IdKind | 'auto' = 'auto'): number {
  let removed = 0;
  db.tx(() => {
    for (const raw of values) {
      const k = kind === 'auto' ? detectKind(raw) : kind;
      if (!k) continue;
      removed += db.run('DELETE FROM exclusion_entries WHERE list_id = ? AND workspace_id = ? AND kind = ? AND value = ?', [listId, workspaceId, k, normalize(k, raw)]).changes;
    }
  });
  return removed;
}

export function listEntries(db: Db, workspaceId: number, listId: number, q: { kind?: IdKind; search?: string; limit: number; offset: number }) {
  const where = ['list_id = ?', 'workspace_id = ?'];
  const params: (string | number)[] = [listId, workspaceId];
  if (q.kind) { where.push('kind = ?'); params.push(q.kind); }
  if (q.search) { where.push(`value LIKE ? ${LIKE_ESCAPE}`); params.push(contains(q.search.toLowerCase())); }
  const total = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM exclusion_entries WHERE ${where.join(' AND ')}`, params)!.n;
  const data = db.all(`SELECT kind, value FROM exclusion_entries WHERE ${where.join(' AND ')} ORDER BY kind, value LIMIT ? OFFSET ?`, [...params, q.limit, q.offset]);
  return { data, total };
}

/** Does the workspace have any exclusions at all? (fast path for the common empty case) */
export function hasExclusions(db: Db, workspaceId: number): boolean {
  return !!db.get('SELECT 1 FROM exclusion_entries WHERE workspace_id = ? LIMIT 1', [workspaceId]);
}

/** The subset of `values` (normalised, one kind) present in any list of the workspace. */
function present(db: Db, workspaceId: number, kind: IdKind, values: Set<string>): Set<string> {
  const out = new Set<string>();
  const all = [...values];
  for (let i = 0; i < all.length; i += 500) {
    const chunk = all.slice(i, i + 500);
    const rows = db.all<{ value: string }>(`SELECT DISTINCT value FROM exclusion_entries WHERE workspace_id = ? AND kind = ? AND value IN (${chunk.map(() => '?').join(',')})`, [workspaceId, kind, ...chunk]);
    for (const r of rows) out.add(r.value);
  }
  return out;
}

export interface FilterResult<T> {
  kept: T[];
  excluded: number;
  /** Rows excluded per matching identifier kind. */
  reasons: Partial<Record<IdKind, number>>;
}

/**
 * Drop rows matching any exclusion in the workspace. A row matches on its place id,
 * LinkedIn URL, email, phone, domain (an email's domain counts) or normalised company name.
 */
export function filterExcluded<T extends Record<string, unknown>>(db: Db, workspaceId: number, rows: T[]): FilterResult<T> {
  if (!rows.length || !hasExclusions(db, workspaceId)) return { kept: rows, excluded: 0, reasons: {} };
  const ids = rows.map((r) => rowIds(r));
  const wanted = Object.fromEntries(ID_KINDS.map((k) => [k, new Set<string>()])) as Record<IdKind, Set<string>>;
  for (const id of ids) {
    for (const k of ID_KINDS) if (id[k]) wanted[k].add(id[k]!);
    if (id.email) wanted.domain.add(id.email.split('@')[1]);
  }
  const hits = Object.fromEntries(ID_KINDS.map((k) => [k, wanted[k].size ? present(db, workspaceId, k, wanted[k]) : new Set<string>()])) as Record<IdKind, Set<string>>;
  const kept: T[] = [];
  const reasons: Partial<Record<IdKind, number>> = {};
  rows.forEach((row, i) => {
    const why = matchKind(ids[i], hits);
    if (why) reasons[why] = (reasons[why] ?? 0) + 1; else kept.push(row);
  });
  return { kept, excluded: rows.length - kept.length, reasons };
}

function matchKind(id: Partial<Record<IdKind, string>>, hits: Record<IdKind, Set<string>>): IdKind | null {
  for (const k of ['place', 'linkedin', 'email', 'phone', 'domain', 'company'] as IdKind[]) if (id[k] && hits[k].has(id[k]!)) return k;
  const emailDomain = id.email?.split('@')[1];
  if (emailDomain && !isFreemail(emailDomain) && hits.domain.has(emailDomain)) return 'domain';
  return null;
}

/** One record against the workspace's exclusions. */
export function isExcluded(db: Db, workspaceId: number, row: Record<string, unknown>): boolean {
  return filterExcluded(db, workspaceId, [row]).excluded > 0;
}

/** A table's rows as `{ column name: value }` (cell JSON parsed; enrichment wrappers intact). */
export function tableRows(db: Db, tableId: number): Record<string, unknown>[] {
  const cells = db.all<{ row_id: number; name: string; value: string | null }>(`SELECT c.row_id, col.name, c.value FROM gtm_cells c
    JOIN gtm_columns col ON col.id = c.column_id JOIN gtm_rows r ON r.id = c.row_id
    WHERE r.table_id = ? AND c.value IS NOT NULL ORDER BY r.position`, [tableId]);
  const rows = new Map<number, Record<string, unknown>>();
  for (const c of cells) {
    let v: unknown = c.value;
    try { v = JSON.parse(c.value!); } catch { /* raw */ }
    let r = rows.get(c.row_id);
    if (!r) rows.set(c.row_id, (r = {}));
    r[c.name] = v;
  }
  return [...rows.values()];
}

/** Add every company/person identifier found in a table's rows. */
export function addFromTable(db: Db, workspaceId: number, listId: number, tableId: number, kinds: IdKind[] = ID_KINDS) {
  const rows = tableRows(db, tableId);
  const entries: { kind: IdKind; value: string }[] = [];
  for (const row of rows) {
    const id = rowIds(row);
    for (const k of kinds) if (id[k]) entries.push({ kind: k, value: id[k]! });
  }
  return { rows: rows.length, added: addEntries(db, workspaceId, listId, entries) };
}

/** Exclude everyone already in Outreach: all leads, or only leads attached to a campaign. */
export function addFromOutreach(db: Db, workspaceId: number, listId: number, opts: { scope: 'leads' | 'campaigns'; includeDomains?: boolean; includeCompanies?: boolean }) {
  const leads = opts.scope === 'campaigns'
    ? db.all<{ email: string; company: string }>(`SELECT DISTINCT l.email, l.company FROM leads l JOIN campaign_leads cl ON cl.lead_id = l.id
        JOIN campaigns c ON c.id = cl.campaign_id WHERE l.workspace_id = ? AND c.workspace_id = ?`, [workspaceId, workspaceId])
    : db.all<{ email: string; company: string }>('SELECT email, company FROM leads WHERE workspace_id = ?', [workspaceId]);
  const entries: { kind: IdKind; value: string }[] = [];
  for (const l of leads) {
    const email = normalize('email', l.email);
    if (email) entries.push({ kind: 'email', value: email });
    const domain = email.split('@')[1];
    if (opts.includeDomains && domain && !isFreemail(domain)) entries.push({ kind: 'domain', value: domain });
    const company = opts.includeCompanies ? normalize('company', l.company) : '';
    if (company) entries.push({ kind: 'company', value: company });
  }
  return { leads: leads.length, added: addEntries(db, workspaceId, listId, entries) };
}
