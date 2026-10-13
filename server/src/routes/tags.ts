import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.ts';
import { auth, bool, canWrite, defineRoutes, idList, idParam, notFound, parse } from '../http.ts';
import { emit } from '../events.ts';

export type Taggable = 'lead' | 'campaign' | 'sender_email';

const TABLE: Record<Taggable, string> = { lead: 'leads', campaign: 'campaigns', sender_email: 'sender_emails' };
const TYPE_NAME: Record<Taggable, string> = { lead: 'Lead', campaign: 'Campaign', sender_email: 'SenderEmail' };

/** Mailboxes tagged with one of these names are warmup-only: their mail stays out of the master inbox and the sent folder. */
export const WARMUP_TAG_NAMES = ['warmup', 'warm-up', 'warm up'];

/**
 * SQL condition that is true when `col` (a sender_email_id column) is not a warmup-tagged mailbox.
 * Bind the workspace id once for it. NULL (no mailbox) counts as visible.
 */
export function notWarmupMailbox(col: string) {
  return `(${col} IS NULL OR ${col} NOT IN (SELECT x.taggable_id FROM taggables x JOIN tags t ON t.id = x.tag_id
    WHERE x.taggable_type = 'sender_email' AND t.workspace_id = ? AND lower(trim(t.name)) IN (${WARMUP_TAG_NAMES.map((n) => `'${n}'`).join(', ')})))`;
}

export function tagsFor(ctx: Ctx, type: Taggable, id: number) {
  return ctx.db.all(`SELECT t.id, t.name, t.is_default AS "default" FROM tags t JOIN taggables x ON x.tag_id = t.id WHERE x.taggable_type = ? AND x.taggable_id = ? ORDER BY t.name`, [type, id])
    .map((t) => ({ ...t, default: !!t.default }));
}

export function setTags(ctx: Ctx, workspaceId: number, type: Taggable, tagIds: number[], targetIds: number[], attach: boolean, skipWebhooks = false) {
  const { db } = ctx;
  const ph = (n: number) => Array(n).fill('?').join(',');
  const tags = db.all(`SELECT * FROM tags WHERE workspace_id = ? AND id IN (${ph(tagIds.length)})`, [workspaceId, ...tagIds]);
  const targets = db.all(`SELECT id FROM ${TABLE[type]} WHERE workspace_id = ? AND id IN (${ph(targetIds.length)})`, [workspaceId, ...targetIds]).map((r) => r.id as number);
  let changed = 0;
  db.tx(() => {
    for (const tag of tags) {
      for (const id of targets) {
        const r = attach
          ? db.run('INSERT OR IGNORE INTO taggables (tag_id, taggable_type, taggable_id) VALUES (?, ?, ?)', [tag.id, type, id])
          : db.run('DELETE FROM taggables WHERE tag_id = ? AND taggable_type = ? AND taggable_id = ?', [tag.id, type, id]);
        if (r.changes) {
          changed++;
          emit(ctx, workspaceId, attach ? 'TAG_ATTACHED' : 'TAG_REMOVED', { tag_id: tag.id, tag_name: tag.name, taggable_id: id, taggable_type: TYPE_NAME[type] }, {}, { skipWebhooks });
        }
      }
    }
  });
  return changed;
}

export function tagRoutes(app: FastifyInstance, ctx: Ctx) {
  const r = defineRoutes(app, 'Custom Tags');
  const { db } = ctx;

  r.get('/api/tags', 'Get all tags for workspace', (req) => {
    const a = auth(req);
    return {
      data: db.all(
        `SELECT t.id, t.name, t.is_default AS "default", t.created_at,
           (SELECT COUNT(*) FROM taggables x WHERE x.tag_id = t.id) AS usage_count
         FROM tags t WHERE workspace_id = ? ORDER BY t.name`, [a.workspaceId]).map((t) => ({ ...t, default: !!t.default })),
    };
  });

  const createBody = z.object({ name: z.string().trim().min(1).max(60) });
  r.post('/api/tags', 'Create tag', (req) => {
    const a = canWrite(req);
    const b = parse(createBody, req.body);
    db.run('INSERT OR IGNORE INTO tags (workspace_id, name) VALUES (?, ?)', [a.workspaceId, b.name]);
    return { data: db.get('SELECT id, name, is_default AS "default" FROM tags WHERE workspace_id = ? AND name = ?', [a.workspaceId, b.name]) };
  }, { body: createBody });

  r.get('/api/tags/:id', 'View tag', (req) => {
    const a = auth(req);
    const t = db.get('SELECT id, name, is_default AS "default" FROM tags WHERE id = ? AND workspace_id = ?', [idParam(req), a.workspaceId]);
    if (!t) throw notFound('tag');
    return { data: t };
  });

  r.delete('/api/tags/:id', 'Remove tag', (req) => {
    const a = canWrite(req);
    const n = db.run('DELETE FROM tags WHERE id = ? AND workspace_id = ?', [idParam(req), a.workspaceId]).changes;
    if (!n) throw notFound('tag');
    return { data: { success: true } };
  });

  for (const [type, plural, key] of [['lead', 'leads', 'lead_ids'], ['campaign', 'campaigns', 'campaign_ids'], ['sender_email', 'sender-emails', 'sender_email_ids']] as const) {
    const body = z.object({ tag_ids: idList, [key]: idList, skip_webhooks: bool.default(false) });
    for (const attach of [true, false]) {
      r.post(`/api/tags/${attach ? 'attach-to' : 'remove-from'}-${plural}`, `${attach ? 'Attach tags to' : 'Remove tags from'} ${plural.replace('-', ' ')}`, (req) => {
        const a = canWrite(req);
        const b = parse(body, req.body) as any;
        return { data: { changed: setTags(ctx, a.workspaceId, type, b.tag_ids, b[key], attach, b.skip_webhooks) } };
      }, { body });
    }
  }
}
