/**
 * "Learnings": one pinned Knowledge Hub doc that Kinetic writes itself, so results feed
 * back into every prompt (agent, AI columns, reply drafts). A/B test winners and won
 * deals each add one dated line, newest first; only the last MAX_LEARNINGS are kept so
 * the prompt context stays small. Text the user writes above the lines is kept.
 */
import type { Db } from '../db/db.ts';
import { createDoc, type KnowledgeDoc } from './store.ts';

export const LEARNINGS_TITLE = 'Learnings';
export const MAX_LEARNINGS = 50;
const INTRO = 'What has worked in our outreach, newest first. Kinetic adds a line when an A/B test picks a winner or a deal is won. Lean on these when writing copy.';
const LINE = /^- \d{4}-\d{2}-\d{2} — /;

/** Adds a dated line to the workspace's Learnings doc (created and pinned on first use). */
export function addLearning(ctx: { db: Db; now: () => Date }, workspaceId: number, text: string): KnowledgeDoc {
  const { db } = ctx;
  const line = `- ${ctx.now().toISOString().slice(0, 10)} — ${text.replace(/\s+/g, ' ').trim()}`;
  const doc = db.get<KnowledgeDoc>('SELECT * FROM knowledge_docs WHERE workspace_id = ? AND lower(title) = lower(?) ORDER BY id LIMIT 1', [workspaceId, LEARNINGS_TITLE]);
  if (!doc) return createDoc(db, workspaceId, { title: LEARNINGS_TITLE, content: `${INTRO}\n\n${line}\n`, pinned: true, created_by: 'agent' });
  const lines = doc.content.split('\n');
  const intro = lines.filter((l) => !LINE.test(l)).join('\n').trim();
  const kept = [line, ...lines.filter((l) => LINE.test(l))].slice(0, MAX_LEARNINGS);
  const content = `${intro ? `${intro}\n\n` : ''}${kept.join('\n')}\n`;
  db.run('UPDATE knowledge_docs SET content = ?, updated_at = ? WHERE id = ?', [content, ctx.now().toISOString(), doc.id]);
  return { ...doc, content };
}

/** Best-effort wrapper: a learning must never break the action that produced it. */
export function tryAddLearning(ctx: { db: Db; now: () => Date; log?: { warn: (...a: any[]) => void } }, workspaceId: number, text: string) {
  try {
    addLearning(ctx, workspaceId, text);
  } catch (err) {
    ctx.log?.warn({ err }, 'could not record a learning');
  }
}
