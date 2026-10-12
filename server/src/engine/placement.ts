/**
 * Inbox placement tests: send a campaign step from chosen mailboxes to seed accounts
 * (test inboxes you own at Gmail, Outlook, Yahoo...) and check, over IMAP, whether each
 * copy landed in the inbox or in spam.
 */
import type { Ctx } from '../context.ts';
import type { Row } from '../db/db.ts';
import { randomToken } from '../lib/crypto.ts';
import { withSeedImap } from '../mail/gateway.ts';
import { findFolders } from './inbox.ts';
import { composeCampaignEmail } from './compose.ts';

const GIVE_UP_AFTER_MS = 20 * 60_000;

export async function startPlacementTest(ctx: Ctx, o: { workspaceId: number; campaignId: number; stepId?: number; senderIds: number[]; seedIds?: number[] }): Promise<number> {
  const { db } = ctx;
  const campaign = db.get('SELECT * FROM campaigns WHERE id = ? AND workspace_id = ?', [o.campaignId, o.workspaceId]);
  if (!campaign) throw new Error('campaign not found');
  const step = o.stepId
    ? db.get('SELECT * FROM sequence_steps WHERE id = ? AND campaign_id = ?', [o.stepId, campaign.id])
    : db.get('SELECT * FROM sequence_steps WHERE campaign_id = ? AND variant_of_step_id IS NULL ORDER BY step_order LIMIT 1', [campaign.id]);
  if (!step) throw new Error('campaign has no sequence steps');
  const seeds = o.seedIds?.length
    ? db.all(`SELECT * FROM seed_accounts WHERE id IN (${o.seedIds.map(() => '?').join(',')})`, o.seedIds)
    : db.all('SELECT * FROM seed_accounts');
  if (!seeds.length) throw new Error('add at least one seed account first (Inbox Placement → Seed accounts)');
  const senders = db.all(`SELECT * FROM sender_emails WHERE workspace_id = ? AND id IN (${o.senderIds.map(() => '?').join(',') || 'NULL'})`, [o.workspaceId, ...o.senderIds]);
  if (!senders.length) throw new Error('choose at least one sender email');

  const testId = db.insert('placement_tests', {
    workspace_id: o.workspaceId, campaign_id: campaign.id, sequence_step_id: step.id,
    name: `${campaign.name} — step ${step.step_order}`, code: randomToken(8), status: 'sending',
    created_at: ctx.now().toISOString(),
  });

  for (const sender of senders) {
    for (const seed of seeds) {
      const lead = { id: 0, email: seed.email, first_name: 'Alex', last_name: 'Taylor', company: 'Acme', title: 'Manager', custom_variables: '{}' };
      const { message } = composeCampaignEmail(ctx, { campaign, step, lead, sender, previous: null });
      const resultId = db.insert('placement_results', { placement_test_id: testId, sender_email_id: sender.id, seed_account_id: seed.id, message_id: message.messageId, result: 'pending' });
      try {
        await ctx.mail.send(sender, { ...message, to: seed.email, headers: {} });
      } catch (err: any) {
        db.update('placement_results', resultId, { result: 'send_failed', error: String(err?.message ?? err).slice(0, 300), checked_at: ctx.now().toISOString() });
      }
    }
  }
  db.update('placement_tests', testId, { status: 'waiting' });
  return testId;
}

/** Checks pending results. Called periodically by the worker. */
export async function checkPlacementTests(ctx: Ctx): Promise<void> {
  const { db } = ctx;
  const tests = db.all(`SELECT * FROM placement_tests WHERE status = 'waiting'`);
  for (const t of tests) {
    const pending = db.all(`SELECT * FROM placement_results WHERE placement_test_id = ? AND result = 'pending'`, [t.id]);
    const bySeed = new Map<number, Row[]>();
    for (const r of pending) bySeed.set(r.seed_account_id, [...(bySeed.get(r.seed_account_id) ?? []), r]);

    for (const [seedId, results] of bySeed) {
      const seed = db.get('SELECT * FROM seed_accounts WHERE id = ?', [seedId]);
      if (!seed) continue;
      try {
        await withSeedImap(seed as any, async (client) => {
          const { inbox, spam } = await findFolders(client);
          for (const [folder, kind] of [[inbox, 'inbox'], [spam, 'spam']] as [string | null, 'inbox' | 'spam'][]) {
            if (!folder) continue;
            const lock = await client.getMailboxLock(folder);
            try {
              for (const r of results) {
                if (r.result !== 'pending') continue;
                const hits = await client.search({ header: { 'message-id': r.message_id } }, { uid: true });
                if (hits && hits.length) {
                  r.result = kind;
                  db.update('placement_results', r.id, { result: kind, checked_at: ctx.now().toISOString() });
                }
              }
            } finally {
              lock.release();
            }
          }
        });
      } catch (err: any) {
        for (const r of results) db.update('placement_results', r.id, { error: String(err?.message ?? err).slice(0, 300) });
      }
    }

    const age = ctx.now().getTime() - Date.parse(t.created_at);
    if (age > GIVE_UP_AFTER_MS) {
      db.run(`UPDATE placement_results SET result = 'missing', checked_at = ? WHERE placement_test_id = ? AND result = 'pending'`, [ctx.now().toISOString(), t.id]);
    }
    const left = db.get<{ n: number }>(`SELECT COUNT(*) n FROM placement_results WHERE placement_test_id = ? AND result = 'pending'`, [t.id])!.n;
    if (!left) db.update('placement_tests', t.id, { status: 'completed', completed_at: ctx.now().toISOString() });
  }
}

export function placementSummary(ctx: Ctx, testId: number) {
  const rows = ctx.db.all(
    `SELECT r.*, s.provider AS seed_provider, s.email AS seed_email, se.email AS sender_email
     FROM placement_results r JOIN seed_accounts s ON s.id = r.seed_account_id LEFT JOIN sender_emails se ON se.id = r.sender_email_id
     WHERE r.placement_test_id = ? ORDER BY se.email, s.provider`, [testId]);
  const total = rows.length;
  const count = (k: string) => rows.filter((r) => r.result === k).length;
  const byProvider: Record<string, { inbox: number; spam: number; missing: number; pending: number }> = {};
  for (const r of rows) {
    const p = (byProvider[r.seed_provider] ??= { inbox: 0, spam: 0, missing: 0, pending: 0 });
    if (r.result === 'inbox') p.inbox++;
    else if (r.result === 'spam') p.spam++;
    else if (r.result === 'pending') p.pending++;
    else p.missing++;
  }
  return {
    total, inbox: count('inbox'), spam: count('spam'), missing: count('missing') + count('send_failed'), pending: count('pending'),
    inbox_rate: total ? Math.round((count('inbox') / total) * 100) : 0,
    by_provider: byProvider,
    results: rows,
  };
}
