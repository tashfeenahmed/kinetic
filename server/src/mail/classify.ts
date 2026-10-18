import { simpleParser, type ParsedMail, type AddressObject } from 'mailparser';
import { htmlToText, stripQuoted } from '../lib/html.ts';

export type Category = 'reply' | 'interested' | 'not_interested' | 'unsubscribe' | 'auto_reply' | 'bounce' | 'other';

export interface InboundMessage {
  messageId: string;
  inReplyTo: string | null;
  references: string[];
  fromName: string;
  fromEmail: string;
  to: string;
  cc: string;
  subject: string;
  text: string;
  html: string;
  date: Date;
  headers: Map<string, unknown>;
  /** inline: an image shown inside the HTML body (a logo or pasted screenshot), not a file the sender attached. */
  attachments: { filename: string; size: number; contentType: string; content: Buffer; inline?: boolean }[];
  /** For delivery-status notifications: details of the bounced message. */
  bounce: { originalMessageId: string | null; recipient: string | null; permanent: boolean; diagnostic: string } | null;
}

const strip = (id: string | undefined | null) => (id ? id.trim().replace(/^<|>$/g, '') : null);

/** Escapes a literal string for embedding in a RegExp (same pattern as the repo's other escapers). */
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function addr(a: AddressObject | AddressObject[] | undefined): { text: string; first?: { name: string; address: string } } {
  const list = Array.isArray(a) ? a : a ? [a] : [];
  const values = list.flatMap((x) => x.value);
  return { text: values.map((v) => v.address).filter(Boolean).join(', '), first: values[0] ? { name: values[0].name ?? '', address: values[0].address ?? '' } : undefined };
}

export async function parseInbound(source: Buffer | string): Promise<InboundMessage> {
  const m: ParsedMail = await simpleParser(source);
  const from = addr(m.from).first;
  const refs = Array.isArray(m.references) ? m.references : m.references ? String(m.references).split(/\s+/) : [];
  const html = typeof m.html === 'string' ? m.html : '';
  const text = m.text ?? (html ? htmlToText(html) : '');
  const msg: InboundMessage = {
    messageId: strip(m.messageId) ?? `missing-${Date.now()}-${Math.random().toString(36).slice(2)}@kinetic.local`,
    inReplyTo: strip(m.inReplyTo),
    references: refs.map((r) => strip(r)!).filter(Boolean),
    fromName: from?.name ?? '',
    fromEmail: (from?.address ?? '').toLowerCase(),
    to: addr(m.to).text,
    cc: addr(m.cc).text,
    subject: m.subject ?? '',
    text,
    html,
    date: m.date ?? new Date(),
    headers: m.headers,
    attachments: realFiles(m.attachments
      .filter((a) => a.contentType !== 'message/delivery-status' && a.contentType !== 'text/rfc822-headers' && a.contentType !== 'message/rfc822')
      .map((a) => ({ filename: a.filename ?? 'attachment', size: a.size, contentType: a.contentType, content: a.content, inline: !!a.related || (a.contentDisposition === 'inline' && !!a.cid && a.contentType.startsWith('image/')) }))),
    bounce: null,
  };
  msg.bounce = detectBounce(m, msg);
  return msg;
}

// Other versions of the message body that mail parsers list as attachments: Gmail's AMP email and emoji reactions.
const BODY_VARIANTS = new Set(['text/x-amp-html', 'text/vnd.google.email-reaction+json']);

/**
 * Drops message parts that aren't files the sender attached: AMP and reaction bodies, and the
 * unnamed calendar part of an invite that also carries invite.ics. A lone unnamed calendar
 * part (the only copy of the invite) is kept and named invite.ics. Works on stored rows too.
 */
export function realFiles<T extends { filename: string; contentType?: string; content_type?: string }>(list: T[]): T[] {
  const type = (a: T) => String(a.contentType ?? a.content_type ?? '').toLowerCase();
  const unnamedCal = (a: T) => type(a) === 'text/calendar' && (!a.filename || a.filename === 'attachment');
  const hasIcs = list.some((a) => !unnamedCal(a) && (/calendar|ics/.test(type(a)) || /\.ics$/i.test(a.filename)));
  return list
    .filter((a) => !BODY_VARIANTS.has(type(a)) && !(unnamedCal(a) && hasIcs))
    .map((a) => (unnamedCal(a) ? { ...a, filename: 'invite.ics' } : a));
}

function detectBounce(m: ParsedMail, msg: InboundMessage) {
  const ct = String(m.headers.get('content-type') && (m.headers.get('content-type') as any).value || '').toLowerCase();
  const reportType = String((m.headers.get('content-type') as any)?.params?.['report-type'] ?? '').toLowerCase();
  const fromDaemon = /mailer-daemon|postmaster|mail delivery (subsystem|system)/i.test(`${msg.fromName} ${msg.fromEmail}`);
  const subjectBounce = /(undeliver|delivery (status notification|has failed|failure)|returned mail|failure notice|mail delivery failed|could not be delivered)/i.test(msg.subject);
  const isReport = ct.includes('multipart/report') && reportType.includes('delivery-status');
  if (!isReport && !(fromDaemon && subjectBounce)) return null;

  // Pull fields from the machine-readable part when present, otherwise from the text.
  const dsnPart = m.attachments.find((a) => a.contentType === 'message/delivery-status');
  // mailparser usually inlines message/delivery-status into the text body.
  const dsn = dsnPart ? dsnPart.content.toString('utf8') : msg.text;
  const original = m.attachments.find((a) => a.contentType === 'message/rfc822' || a.contentType === 'text/rfc822-headers');
  const originalText = original ? original.content.toString('utf8') : msg.text;

  const recipient = /Final-Recipient:\s*rfc822;\s*([^\s;]+)/i.exec(dsn)?.[1]
    ?? (m.headers.get('x-failed-recipients') as string | undefined)
    ?? /([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i.exec(msg.text.replace(new RegExp(escapeRe(msg.fromEmail), 'gi'), ''))?.[1]
    ?? null;
  const status = /Status:\s*(\d\.\d+\.\d+)/i.exec(dsn)?.[1] ?? /\b([45]\.\d{1,3}\.\d{1,3})\b/.exec(msg.text)?.[1] ?? '';
  const action = /Action:\s*(\w+)/i.exec(dsn)?.[1]?.toLowerCase() ?? '';
  if (action === 'delayed' || action === 'delivered' || action === 'relayed') return null;
  const diagnostic = /Diagnostic-Code:\s*(.+)/i.exec(dsn)?.[1]?.trim() ?? msg.text.split('\n').find((l) => /\b[45]\d\d\b/.test(l))?.trim() ?? '';
  const originalMessageId = strip(/^Message-ID:\s*(<[^>]+>)/im.exec(originalText)?.[1] ?? null) ?? msg.inReplyTo;
  return { originalMessageId, recipient: recipient?.toLowerCase() ?? null, permanent: !status.startsWith('4'), diagnostic };
}

export function isAutoReply(msg: InboundMessage): boolean {
  const h = (k: string) => String(msg.headers.get(k) ?? '').toLowerCase();
  if (h('auto-submitted') && h('auto-submitted') !== 'no') return true;
  if (msg.headers.has('x-autoreply') || msg.headers.has('x-autorespond') || h('x-auto-response-suppress').includes('all')) return true;
  if (['auto_reply', 'bulk', 'junk', 'list'].includes(h('precedence'))) return true;
  return /^(auto(matic)?[ -]?(reply|response)|out of (the )?office|ooo\b|away from|on vacation|abwesenheit|absence|r[ée]ponse automatique)/i.test(msg.subject.replace(/^(re|aw|fw|fwd):\s*/i, ''));
}

const UNSUB = /\b(unsubscribe|remove me|take me off|stop (emailing|contacting|sending)|do not (contact|email)|don'?t (contact|email)|opt[- ]?out|not interested\b.*\b(remove|stop))/i;
const NOT_INTERESTED = /\b(not interested|no thanks|no thank you|not a fit|not a priority|we('| a)re (all )?set|pass on this|not looking|not right now|no need)\b/i;
const INTERESTED = /\b(interested|sounds (good|great|interesting)|let'?s (talk|chat|connect|do it|set)|happy to (chat|talk|connect|learn)|tell me more|more info|send (me )?(over )?(more|details|info)|book (a )?(call|time|meeting)|calendar|calendly|schedule (a )?(call|time|meeting)|what (does it|do you) cost|pricing|free (next|this|on|tomorrow)|works for me|available (on|next|this|tomorrow)|yes[,! ]|sure[,! ]|let me know (a )?time|call (me|next)|demo)\b/i;

/** Rule-based categorization of a human reply. Order matters: unsubscribe beats interested. */
export function categorize(msg: InboundMessage, ignorePhrases: string[] = []): { category: Category; interested: boolean; automated: boolean } {
  if (msg.bounce) return { category: 'bounce', interested: false, automated: true };
  if (isAutoReply(msg)) return { category: 'auto_reply', interested: false, automated: true };
  const body = stripQuoted(msg.text || htmlToText(msg.html)).slice(0, 4000);
  const hay = `${msg.subject}\n${body}`.toLowerCase();
  if (ignorePhrases.some((p) => p && hay.includes(p.toLowerCase()))) return { category: 'other', interested: false, automated: true };
  if (UNSUB.test(body)) return { category: 'unsubscribe', interested: false, automated: false };
  if (NOT_INTERESTED.test(body)) return { category: 'not_interested', interested: false, automated: false };
  if (INTERESTED.test(body)) return { category: 'interested', interested: true, automated: false };
  return { category: 'reply', interested: false, automated: false };
}
