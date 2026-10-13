/**
 * The Markdown emails are written in, rendered the same way the server sends them
 * (server/src/lib/markdown.ts), so the composer's preview matches what the lead gets.
 */
import { Marked, type Tokens } from 'marked';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const looksLikeHtml = (s: string) => /<(p|div|br|a|strong|em|b|i|ul|ol|li|span|table)[\s>/]/i.test(s);

const md = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    html(token: Tokens.HTML | Tokens.Tag) { return 'block' in token && token.block ? `<p>${esc(token.text.trim()).replace(/\n/g, '<br>')}</p>\n` : esc(token.text); },
    link(token: Tokens.Link) {
      const text = this.parser.parseInline(token.tokens);
      if (!/^(https?:|mailto:)/i.test(token.href)) return text;
      return `<a href="${esc(token.href)}">${text}</a>`;
    },
    image(token: Tokens.Image) {
      return /^https?:/i.test(token.href) ? `<img src="${esc(token.href)}" alt="${esc(token.text)}" style="max-width:100%">` : esc(token.text);
    },
  },
});

export function emailMarkdownToHtml(text: string): string {
  if (looksLikeHtml(text)) return text;
  return (md.parse(text ?? '', { async: false }) as string).trim();
}
