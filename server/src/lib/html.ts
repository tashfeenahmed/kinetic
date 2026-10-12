export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Detects bodies that are already HTML (from the rich editor or API). */
export const looksLikeHtml = (s: string) => /<(p|div|br|a|strong|em|b|i|ul|ol|li|span|table)[\s>/]/i.test(s);

/** Plain text -> simple HTML paragraphs with clickable links. */
export function textToHtml(text: string): string {
  if (looksLikeHtml(text)) return text;
  return text
    .split(/\n{2,}/)
    .map((para) => `<p>${linkify(escapeHtml(para)).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

function linkify(escaped: string): string {
  return escaped.replace(/\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]/g, (url) => `<a href="${url}">${url}</a>`);
}

/** HTML -> readable plain text. */
export function htmlToText(html: string): string {
  if (!looksLikeHtml(html)) return html;
  return html
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<a [^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi, (_m, href: string, label: string) => (label.trim() === href ? href : `${label} (${href})`))
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Strips quoted history from a reply so the inbox preview shows only the new text. */
export function stripQuoted(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    if (/^On .{5,200}wrote:\s*$/.test(line) || /^-{2,}\s*Original Message\s*-{2,}/i.test(line) || /^From: .+/.test(line) && out.length > 0) break;
    if (line.startsWith('>')) continue;
    out.push(line);
  }
  return out.join('\n').trim();
}
