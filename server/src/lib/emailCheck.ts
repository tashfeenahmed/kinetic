/**
 * Pre-send check: a deterministic lint for a rendered campaign email.
 *
 * Errors mean the email would go out broken (leftover placeholders, empty parts)
 * and block that send. Warnings flag things that read as spammy or AI-written and
 * never block.
 */
import { htmlToText, looksLikeHtml } from './html.ts';

export interface Issue {
  code: string;
  message: string;
  excerpt?: string;
}

export interface CheckInput {
  subject: string;
  body: string;
  /** Thread replies reuse the earlier subject, so theirs is not checked. */
  threaded?: boolean;
  /** First step of a cold sequence: held to a shorter length. */
  firstStep?: boolean;
}

/** Phrases that read as spammy or machine-written. `subject: true` only checks the subject. */
export const FLAGGED_PHRASES: { pattern: RegExp; subject?: boolean }[] = [
  { pattern: /I hope (this|my) (email|message|note) finds you well/i },
  { pattern: /\bdelve\b/i },
  { pattern: /\bgame[- ]changer\b/i },
  { pattern: /\bleverag\w* synerg\w*/i },
  { pattern: /\btouch base\b/i },
  { pattern: /\bcircle back\b/i },
  { pattern: /\bin today's (fast-paced|digital|ever-changing)\b/i },
  { pattern: /\bunlock (the|your) (full )?potential\b/i },
  { pattern: /\b100% free\b/i },
  { pattern: /\bact now\b/i },
  { pattern: /\bguarantee(d)?\b/i },
  { pattern: /\brisk[- ]free\b/i },
  { pattern: /\bclick here\b/i },
  { pattern: /\bquick question\b/i, subject: true },
];

const SHORTENERS = /\bhttps?:\/\/(www\.)?(bit\.ly|tinyurl\.com|t\.co|goo\.gl|ow\.ly|is\.gd|buff\.ly|rebrand\.ly|cutt\.ly|shorturl\.at|tiny\.cc)\//i;

const excerpt = (s: string) => (s.length > 60 ? `${s.slice(0, 57)}...` : s);

export function checkEmail(input: CheckInput): { errors: Issue[]; warnings: Issue[] } {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const subject = input.threaded ? '' : input.subject.trim();
  const body = input.body;

  // ---- errors ----
  const parts = input.threaded ? [body] : [subject, body];
  for (const part of parts) {
    const placeholder = part.match(/\{\{[^{}]*\}\}|\{[A-Za-z][A-Za-z0-9_ ]*\}/);
    if (placeholder) {
      errors.push({ code: 'leftover_variable', message: `A variable was not filled in: ${placeholder[0]}`, excerpt: placeholder[0] });
      break;
    }
  }
  for (const part of parts) {
    const spin = part.match(/\{[^{}\n]*\|[^{}\n]*\}?/);
    if (spin) {
      errors.push({ code: 'broken_spintax', message: `Text options were not resolved (check the braces): ${excerpt(spin[0])}`, excerpt: excerpt(spin[0]) });
      break;
    }
  }
  const text = (looksLikeHtml(body) ? htmlToText(body) : body).trim();
  if (!text) errors.push({ code: 'empty_body', message: 'The email body is empty.' });
  if (!input.threaded && !subject) errors.push({ code: 'empty_subject', message: 'The subject is empty.' });

  // ---- warnings ----
  for (const { pattern, subject: subjectOnly } of FLAGGED_PHRASES) {
    const m = subject.match(pattern) ?? (subjectOnly ? null : text.match(pattern));
    if (m) warnings.push({ code: 'flagged_phrase', message: `"${m[0]}" can read as spammy or machine-written.`, excerpt: m[0] });
  }
  if (subject.length > 60) warnings.push({ code: 'long_subject', message: `The subject is ${subject.length} characters; keep it under 60.`, excerpt: excerpt(subject) });
  const letters = subject.replace(/[^A-Za-z]/g, '');
  if (letters.length >= 6 && letters.replace(/[^A-Z]/g, '').length / letters.length > 0.6) {
    warnings.push({ code: 'caps_subject', message: 'The subject is mostly capital letters.', excerpt: excerpt(subject) });
  }
  if (subject.includes('!') || /!!/.test(text) || (text.match(/!/g)?.length ?? 0) > 2) {
    warnings.push({ code: 'exclamation', message: 'Too many exclamation marks.' });
  }
  const words = text.split(/\s+/).filter(Boolean).length;
  const maxWords = input.firstStep ? 150 : 200;
  if (words > maxWords) warnings.push({ code: 'long_body', message: `The body is ${words} words; aim for under ${maxWords}.` });
  const links = new Set(body.match(/https?:\/\/[^\s"'<>)]+/gi) ?? []);
  if (links.size > 2) warnings.push({ code: 'many_links', message: `The email has ${links.size} links; keep it to 2 or fewer.` });
  const short = body.match(SHORTENERS);
  if (short) warnings.push({ code: 'link_shortener', message: 'Link shorteners are often flagged as spam; use the full link.', excerpt: short[0] });
  if (/<img\b|!\[[^\]]*\]\(/i.test(body)) warnings.push({ code: 'images', message: 'Images in cold emails hurt deliverability.' });
  if (/<(table|style)\b/i.test(body) || (body.match(/<[a-z][^>]*>/gi)?.length ?? 0) > 30) {
    warnings.push({ code: 'heavy_html', message: 'Heavy HTML formatting looks like a newsletter; keep it plain.' });
  }
  return { errors, warnings };
}
