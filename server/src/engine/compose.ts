import type { Ctx } from '../context.ts';
import type { Row } from '../db/db.ts';
import type { OutgoingMessage } from '../mail/gateway.ts';
import { buildVariables, hashSeed, render } from '../lib/template.ts';
import { markdownToHtml } from '../lib/markdown.ts';
import { escapeHtml, htmlToText, looksLikeHtml, textToHtml } from '../lib/html.ts';
import { hmacSha256, randomToken } from '../lib/crypto.ts';
import { domainOf } from '../lib/dns.ts';

export const newMessageId = (senderEmail: string) => `${randomToken(18)}@${domainOf(senderEmail) || 'kinetic.local'}`;

export function trackingBase(ctx: Ctx, campaign: Row | null): string {
  if (campaign?.custom_tracking_domain_id) {
    const d = ctx.db.get<{ domain: string }>('SELECT domain FROM custom_tracking_domains WHERE id = ?', [campaign.custom_tracking_domain_id]);
    if (d) return `https://${d.domain}`;
  }
  return ctx.config.publicUrl;
}

export const signUrl = (ctx: Ctx, token: string, url: string) => hmacSha256(ctx.config.appKey.toString('base64'), `${token}|${url}`).slice(0, 16);

/** Rewrites links for click tracking. */
function trackLinks(ctx: Ctx, html: string, base: string, token: string): string {
  return html.replace(/href="(https?:\/\/[^"]+)"/gi, (_m, url: string) => {
    if (url.startsWith(base)) return `href="${url}"`;
    const target = url.replace(/&amp;/g, '&');
    return `href="${base}/t/c/${token}?u=${encodeURIComponent(target)}&s=${signUrl(ctx, token, target)}"`;
  });
}

export interface ComposeInput {
  campaign: Row;
  step: Row;        // the chosen variant row
  lead: Row;
  sender: Row;
  previous: Row | null; // last sent email to this lead in this campaign (for threading)
  forceThread?: boolean; // reply-followup campaigns always answer in the existing thread
}

export interface Composed {
  message: OutgoingMessage;
  trackingToken: string;
}

/** Builds the exact message for one campaign step to one lead. */
export function composeCampaignEmail(ctx: Ctx, input: ComposeInput): Composed {
  const { campaign, step, lead, sender, previous } = input;
  const token = randomToken(16);
  const base = trackingBase(ctx, campaign);
  const unsubscribeUrl = `${base}/u/${token}`;

  const vars = buildVariables({
    lead: { ...lead, email: lead.email, custom_variables: safeJson(lead.custom_variables) },
    sender: { name: sender.name, email: sender.email, signature: sender.email_signature },
    extra: { UNSUBSCRIBE_LINK: campaign.can_unsubscribe ? unsubscribeUrl : '' },
  });
  const seed = hashSeed(lead.id, step.step_order, campaign.id);

  const threaded = (!!step.thread_reply || !!input.forceThread) && !!previous;
  let subject = render(step.email_subject ?? '', vars, { seed });
  if (threaded) {
    // Thread replies keep the original subject so mail clients group them.
    const prevSubject = previous!.subject as string;
    subject = /^re:/i.test(prevSubject) ? prevSubject : `Re: ${prevSubject}`;
  }

  let body = render(step.email_body ?? '', vars, { seed: seed + 1 });
  const signature = (sender.email_signature ?? '').trim();
  const usedSignatureVar = /\{SIGNATURE\}/i.test(step.email_body ?? '');
  const isHtml = looksLikeHtml(body) || looksLikeHtml(signature);

  if (!usedSignatureVar && signature) {
    body = isHtml ? `${markdownToHtml(body)}\n${markdownToHtml(signature)}` : `${body}\n\n${signature}`;
  }

  // Quote the previous message in thread replies, like a normal mail client does.
  let quotedText = '';
  let quotedHtml = '';
  if (threaded) {
    const when = new Date(previous!.sent_at).toUTCString().replace(/:\d\d GMT$/, ' GMT');
    const prevText = (previous!.body_text as string) || htmlToText(previous!.body_html as string);
    // Quote whoever wrote the previous message (our mailbox, or the lead for reply follow-ups).
    const qName = previous!.from_name || sender.name;
    const qEmail = previous!.from_email || sender.email;
    quotedText = `\n\nOn ${when}, ${qName} <${qEmail}> wrote:\n${prevText.split('\n').map((l) => `> ${l}`).join('\n')}`;
    quotedHtml = `<br><div class="gmail_quote"><div>On ${escapeHtml(when)}, ${escapeHtml(qName)} &lt;${escapeHtml(qEmail)}&gt; wrote:</div><blockquote style="margin:0 0 0 .8ex;border-left:1px #ccc solid;padding-left:1ex">${previous!.body_html || textToHtml(prevText)}</blockquote></div>`;
  }

  // The body is Markdown (or HTML from the API); the plain-text part is the same message without markup.
  const bodyHtml = markdownToHtml(body);
  const text = htmlToText(bodyHtml) + quotedText;
  let html: string | undefined;
  if (!campaign.plain_text) {
    html = bodyHtml + quotedHtml;
    if (campaign.click_tracking) html = trackLinks(ctx, html, base, token);
    if (campaign.open_tracking) html += `<img src="${base}/t/o/${token}" width="1" height="1" alt="" style="display:none">`;
  }

  const headers: Record<string, string> = {};
  if (campaign.can_unsubscribe) {
    headers['List-Unsubscribe'] = `<${unsubscribeUrl}>, <mailto:${sender.email}?subject=unsubscribe>`;
    headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  }

  const references = threaded ? referenceChain(ctx, previous!) : [];
  return {
    trackingToken: token,
    message: {
      from: { name: sender.name, email: sender.email },
      to: lead.first_name || lead.last_name ? `"${`${lead.first_name} ${lead.last_name}`.trim().replace(/"/g, '')}" <${lead.email}>` : lead.email,
      subject,
      text,
      html,
      messageId: newMessageId(sender.email),
      inReplyTo: threaded ? previous!.message_id : null,
      references,
      headers,
    },
  };
}

/** Message-IDs of the thread so far, oldest first. */
export function referenceChain(ctx: Ctx, last: Row): string[] {
  const chain: string[] = [];
  let cur: Row | undefined = last;
  for (let i = 0; cur && i < 20; i++) {
    chain.unshift(cur.message_id);
    if (!cur.in_reply_to) break;
    cur = ctx.db.get('SELECT message_id, in_reply_to FROM sent_emails WHERE message_id = ?', [cur.in_reply_to])
      ?? ctx.db.get('SELECT message_id, in_reply_to FROM replies WHERE message_id = ?', [cur.in_reply_to]);
    if (!cur) break;
  }
  return chain;
}

export function safeJson(s: unknown): Record<string, string> {
  if (s && typeof s === 'object') return s as Record<string, string>;
  try { return JSON.parse(String(s ?? '{}')); } catch { return {}; }
}

/** Picks the step variant for a lead: even split across active variants, stable per lead. */
export function chooseVariant(variants: Row[], leadId: number, stepOrder: number): Row | null {
  const active = variants.filter((v) => v.active);
  if (!active.length) return null;
  return active[hashSeed(leadId, stepOrder, 'variant') % active.length]!;
}
