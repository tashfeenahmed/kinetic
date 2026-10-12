/**
 * Fine-grained reply labels: the taxonomy, the cheap rule-based refinements, and
 * the prompt + JSON parsing used by the AI classifier. Pure functions (no DB, no HTTP).
 */
import { htmlToText, stripQuoted } from '../lib/html.ts';

/** Labels the AI can choose. */
export const AI_LABELS = [
  'interested', 'meeting_request', 'more_info', 'objection', 'not_interested', 'referral', 'wrong_person',
  'out_of_office', 'auto_reply', 'unsubscribe', 'bounce',
] as const;
/** Every label a reply can carry: the AI ones plus the rule-only `reply` (unsorted human reply) and `other` (ignored phrase). */
export const REPLY_LABELS = [...AI_LABELS, 'reply', 'other'] as const;
export type ReplyLabel = (typeof REPLY_LABELS)[number];

export const OBJECTION_TYPES = ['price', 'timing', 'competitor', 'no_need', 'authority', 'other'] as const;

/** Labels that mean "this person wants to talk" (the interested flag, LEAD_INTERESTED). */
export const INTERESTED_LABELS = new Set<ReplyLabel>(['interested', 'meeting_request']);
/** Labels for machine-written mail (the automated flag). */
export const AUTOMATED_LABELS = new Set<ReplyLabel>(['out_of_office', 'auto_reply', 'bounce']);

export interface Classification {
  label: ReplyLabel;
  confidence: number;
  summary: string;
  next_action: string;
  objection_type: (typeof OBJECTION_TYPES)[number] | null;
  referral: { name: string | null; email: string | null } | null;
  return_date: string | null; // YYYY-MM-DD
}

/** The coarse EmailBison-style category kept in `replies.category` for a label. */
export function coarseCategory(label: ReplyLabel, interested: boolean): string {
  if (INTERESTED_LABELS.has(label)) return interested ? 'interested' : 'reply';
  if (label === 'not_interested' || label === 'unsubscribe' || label === 'bounce' || label === 'other' || label === 'reply') return label;
  if (label === 'out_of_office' || label === 'auto_reply') return 'auto_reply';
  return 'reply';
}

const OOO = /\b(out of (the )?office|ooo\b|on (annual |parental |maternity |paternity |sick )?leave|on (vacation|holiday|holidays|pto)|away (from (the |my )?(office|desk)|until|till)|limited access to (my )?e-?mail|currently (away|travell?ing)|abwesen|abwesenheit|absen(t|ce)|r[ée]ponse automatique|be back (on|in|at)|return(ing)? (on|to the office))/i;

export const replyText = (text: string, html: string) => stripQuoted(text || htmlToText(html || ''));

/** Refines a rule category: auto-replies that read like out-of-office notes become `out_of_office`. */
export function ruleLabel(category: string, subject: string, body: string): ReplyLabel {
  if (category === 'auto_reply' && OOO.test(`${subject}\n${body.slice(0, 1500)}`)) return 'out_of_office';
  return (REPLY_LABELS as readonly string[]).includes(category) ? category as ReplyLabel : 'reply';
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';

const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/**
 * Finds an explicit return date in an out-of-office note ("back on October 20", "until 20 Oct 2026",
 * "2026-10-20"). Weekday names ("back Monday") are left to the AI. Returns the first plausible
 * future date within 180 days, as YYYY-MM-DD, or null.
 */
export function parseReturnDate(text: string, now: Date): string | null {
  const found: { at: number; y: number | null; m: number; d: number }[] = [];
  const t = text.slice(0, 3000);
  for (const m of t.matchAll(/\b(20\d\d)-(\d\d)-(\d\d)\b/g)) found.push({ at: m.index!, y: +m[1]!, m: +m[2]!, d: +m[3]! });
  for (const m of t.matchAll(new RegExp(`\\b${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(20\\d\\d))?`, 'gi'))) {
    found.push({ at: m.index!, y: m[3] ? +m[3] : null, m: MONTHS.indexOf(m[1]!.slice(0, 3).toLowerCase()) + 1, d: +m[2]! });
  }
  for (const m of t.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}\\.?(?:,?\\s+(20\\d\\d))?`, 'gi'))) {
    found.push({ at: m.index!, y: m[3] ? +m[3] : null, m: MONTHS.indexOf(m[2]!.slice(0, 3).toLowerCase()) + 1, d: +m[1]! });
  }
  for (const m of t.matchAll(/\b(\d{1,2})[./](\d{1,2})[./](20\d\d)\b/g)) {
    const a = +m[1]!, b = +m[2]!;
    if (a > 12 && b <= 12) found.push({ at: m.index!, y: +m[3]!, m: b, d: a });
    else if (b > 12 && a <= 12) found.push({ at: m.index!, y: +m[3]!, m: a, d: b });
  }
  found.sort((a, b) => a.at - b.at);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  for (const f of found) {
    if (f.m < 1 || f.m > 12 || f.d < 1 || f.d > 31) continue;
    let y = f.y ?? now.getUTCFullYear();
    let when = Date.UTC(y, f.m - 1, f.d);
    if (f.y == null && when < today) { y += 1; when = Date.UTC(y, f.m - 1, f.d); }
    if (new Date(when).getUTCDate() !== f.d) continue; // 31 Feb etc.
    if (when < today || when - today > 180 * 86_400_000) continue;
    return iso(y, f.m, f.d);
  }
  return null;
}

// ---------------------------------------------------------------------------
// AI prompt + response parsing
// ---------------------------------------------------------------------------

export const CLASSIFY_SYSTEM = `You sort replies to B2B cold emails for a salesperson. Read the prospect's reply and answer with ONE JSON object and nothing else:
{"category": string, "confidence": number 0-1, "summary": string, "next_action": string, "objection_type": string|null, "referral": {"name": string|null, "email": string|null}|null, "return_date": "YYYY-MM-DD"|null}

category is exactly one of:
- "interested": positive, wants to learn more or continue, but no concrete meeting ask yet
- "meeting_request": asks for or accepts a call/meeting/demo, proposes times, or shares a booking link
- "more_info": asks a question (pricing, how it works, who you are) without clear interest or rejection
- "objection": pushes back but the door is open; set objection_type to one of "price", "timing", "competitor", "no_need", "authority"
- "not_interested": clear no, without asking to stop all contact
- "referral": points you to another person who is the right contact; fill referral with their name/email if given
- "wrong_person": says they are not the right person / left the company, without naming someone (fill referral if they do)
- "out_of_office": automatic away/vacation/leave notice; set return_date if a return date is stated (resolve relative dates against today's date)
- "auto_reply": any other automatic message (ticket confirmations, "this inbox is not monitored", newsletters)
- "unsubscribe": asks to stop emailing, remove them, opt out, or threatens to report spam
- "bounce": delivery failure notice

summary: one short sentence (max 25 words) saying what the prospect wants, in English.
next_action: one short imperative sentence for the salesperson (e.g. "Send two time slots for Thursday", "Email jane@acme.com, the referred contact", "Resume the sequence after 2026-10-20").
Unknown fields are null. Never add text outside the JSON.`;

export interface PromptInput {
  subject: string;
  fromName: string;
  fromEmail: string;
  body: string;
  ourLastEmail?: string;
  today: string;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** User message for the classifier; bodies are already stripped of quoted text and are truncated here. */
export function classifyPrompt(p: PromptInput): string {
  return [
    `Today's date: ${p.today}`,
    p.ourLastEmail ? `Our previous email (for context, truncated):\n"""${clip(p.ourLastEmail.trim(), 600)}"""` : '',
    `Reply from: ${p.fromName ? `${p.fromName} <${p.fromEmail}>` : p.fromEmail}`,
    `Subject: ${clip(p.subject, 200)}`,
    `Reply body:\n"""${clip(p.body.trim(), 2000) || '(empty)'}"""`,
  ].filter(Boolean).join('\n\n');
}

const SYNONYMS: Record<string, ReplyLabel> = {
  positive: 'interested', interest: 'interested', meeting: 'meeting_request', meeting_requested: 'meeting_request', call_request: 'meeting_request',
  demo_request: 'meeting_request', question: 'more_info', info_request: 'more_info', information_request: 'more_info', more_information: 'more_info',
  negative: 'not_interested', no: 'not_interested', rejection: 'not_interested', referral_contact: 'referral', wrong_contact: 'wrong_person',
  ooo: 'out_of_office', vacation: 'out_of_office', away: 'out_of_office', automatic_reply: 'auto_reply', autoreply: 'auto_reply',
  unsub: 'unsubscribe', opt_out: 'unsubscribe', remove: 'unsubscribe', do_not_contact: 'unsubscribe', bounced: 'bounce', delivery_failure: 'bounce',
};

function normLabel(v: unknown): ReplyLabel | null {
  const s = String(v ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if ((AI_LABELS as readonly string[]).includes(s)) return s as ReplyLabel;
  return SYNONYMS[s] ?? null;
}

/** Best-effort JSON from a model answer: strips fences/prose, fixes trailing commas, single quotes and bare keys. */
export function repairJson(raw: string): any | null {
  let s = String(raw ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) s = s.slice(start, end + 1);
  else if (start >= 0) s = `${s.slice(start)}}`; // truncated answer
  const attempts = [
    s,
    s.replace(/,\s*([}\]])/g, '$1'),
    s.replace(/,\s*([}\]])/g, '$1').replace(/([{,]\s*)([A-Za-z_][\w]*)\s*:/g, '$1"$2":').replace(/'([^'\\]*)'/g, '"$1"'),
  ];
  for (const a of attempts) {
    try { const v = JSON.parse(a); if (v && typeof v === 'object') return v; } catch { /* next */ }
  }
  return null;
}

/** Turns a model answer into a Classification, or null when no category can be recovered. */
export function parseClassification(raw: string): Classification | null {
  const obj = repairJson(raw);
  let label = normLabel(obj?.category ?? obj?.label);
  if (!label) {
    // Last resort: a quoted category somewhere in the text.
    const m = /"?(?:category|label)"?\s*[:=]\s*"?([a-z_ -]+)"?/i.exec(String(raw ?? ''));
    label = normLabel(m?.[1]);
  }
  if (!label) return null;
  const conf = Number(obj?.confidence);
  const objection = String(obj?.objection_type ?? '').toLowerCase().replace(/[\s-]+/g, '_');
  const ref = obj?.referral && typeof obj.referral === 'object' ? obj.referral : null;
  const refEmail = ref?.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(ref.email)) ? String(ref.email).toLowerCase() : null;
  const date = /^(20\d\d-\d\d-\d\d)/.exec(String(obj?.return_date ?? ''))?.[1] ?? null;
  return {
    label,
    confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf > 1 ? conf / 100 : conf)) : 0.5,
    summary: clip(String(obj?.summary ?? '').trim(), 300),
    next_action: clip(String(obj?.next_action ?? obj?.suggested_action ?? '').trim(), 300),
    objection_type: label === 'objection' ? ((OBJECTION_TYPES as readonly string[]).includes(objection) ? objection as Classification['objection_type'] : 'other') : null,
    referral: (label === 'referral' || label === 'wrong_person') && (ref?.name || refEmail) ? { name: ref?.name ? String(ref.name).slice(0, 200) : null, email: refEmail } : null,
    return_date: label === 'out_of_office' ? date : null,
  };
}
