/** Sending-domain setup: plan → apply through Cloudflare → verify over public DNS. */
import { Resolver } from 'node:dns/promises';
import type { Ctx } from '../context.ts';
import { checkDomain, type DomainReport } from '../lib/dns.ts';
import { Cloudflare, type CfZone } from './cloudflare.ts';
import { plan, type Action, type DomainSetup } from './plan.ts';

export function cloudflare(ctx: Ctx): Cloudflare | null {
  const token = ctx.gtm?.settings.get('CLOUDFLARE_API_TOKEN');
  return token ? new Cloudflare(token, ctx.fetch) : null;
}

/** Hostname tracking CNAMEs should point at, or null when the app isn't reachable publicly. */
export function trackingTarget(ctx: Ctx): string | null {
  const host = new URL(ctx.config.publicUrl).hostname;
  return /^(localhost|127\.|0\.0\.0\.0|\[?::1)/.test(host) || !host.includes('.') ? null : host;
}

export async function findZone(cf: Cloudflare, domain: string): Promise<CfZone | null> {
  const zones = await cf.zones(domain);
  return zones.find((z) => z.name.toLowerCase() === domain.toLowerCase()) ?? null;
}

export async function makePlan(ctx: Ctx, cf: Cloudflare, setup: DomainSetup): Promise<{ zone: CfZone; actions: Action[]; notes: string[] }> {
  const zone = await findZone(cf, setup.domain);
  if (!zone) throw Object.assign(new Error(`${setup.domain} isn't in your Cloudflare account yet — add it first`), { statusCode: 404 });
  const notes: string[] = [];
  const target = trackingTarget(ctx);
  const s = { ...setup, trackingTarget: target ?? undefined };
  if (setup.trackingSubdomain && !target) notes.push(`Tracking domain skipped: PUBLIC_URL (${ctx.config.publicUrl}) isn't a public address, so a CNAME to it wouldn't work.`);
  if (zone.status !== 'active') notes.push(`Cloudflare zone is "${zone.status}": records are saved now but only take effect once your registrar points at Cloudflare's nameservers (${(zone.name_servers ?? []).join(', ')}).`);
  if (setup.provider === 'google' && !setup.dkimValue) notes.push('DKIM not set yet: in Google Admin → Apps → Google Workspace → Gmail → Authenticate email, generate a key, paste it here and apply again, then click "Start authentication" in Google.');
  if (setup.provider === 'microsoft' && !setup.msDkim1) notes.push('DKIM not set yet: in Microsoft Defender → Email authentication settings → DKIM, copy the two CNAME values here and apply again, then enable signing.');
  if (!setup.verification) notes.push(`Add the ${setup.provider === 'microsoft' ? 'MS=ms… TXT value from Microsoft 365 admin → Settings → Domains' : setup.provider === 'google' ? 'google-site-verification TXT value from Google Admin → Domains' : 'provider verification value'} if your provider still needs to verify the domain.`);
  return { zone, actions: plan(await cf.records(zone.id), s), notes };
}

export async function applyActions(cf: Cloudflare, zoneId: string, actions: Action[]) {
  const results: (Action & { ok: boolean; error?: string })[] = [];
  // Deletes first so CNAME/A conflicts and duplicate SPF records are gone before creates.
  const ordered = [...actions.filter((a) => a.op === 'delete'), ...actions.filter((a) => a.op !== 'delete')];
  for (const a of ordered) {
    if (a.op === 'keep') { results.push({ ...a, ok: true }); continue; }
    const body = { type: a.type, name: a.name, content: a.content, ttl: 1, proxied: a.proxied ?? false, ...(a.type === 'MX' ? { priority: a.priority } : {}), comment: 'Managed by Kinetic' };
    try {
      if (a.op === 'create') await cf.createRecord(zoneId, body);
      else if (a.op === 'update') await cf.updateRecord(zoneId, a.recordId!, body);
      else if (a.op === 'delete') await cf.deleteRecord(zoneId, a.recordId!);
      results.push({ ...a, ok: true });
    } catch (e: any) {
      results.push({ ...a, ok: false, error: e.message });
    }
  }
  return results;
}

/** Check over Cloudflare's resolver so results reflect the new records immediately. */
export async function verifyDomain(domain: string, trackingHost?: string | null): Promise<DomainReport & { tracking?: { host: string; ok: boolean; found: string[] } }> {
  const r = new Resolver({ timeout: 5000, tries: 2 });
  r.setServers(['1.1.1.1', '1.0.0.1']);
  const report = await checkDomain(domain, r);
  if (!trackingHost) return report;
  let found: string[] = [];
  try { found = await r.resolveCname(trackingHost); } catch { /* none */ }
  return { ...report, tracking: { host: trackingHost, ok: found.length > 0, found } };
}
