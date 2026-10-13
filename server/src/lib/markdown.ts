import { Marked, type Tokens } from 'marked';
import { escapeHtml, looksLikeHtml } from './html.ts';

/**
 * Markdown for emails people type (inbox replies, new emails, sequence steps): **bold**,
 * _italic_, [links](https://…), lists, headings, > quotes and `code`. Single line breaks
 * stay line breaks, as in a normal email. Raw HTML in the text is shown as text, and only
 * http(s)/mailto links are kept, so a lead's name or company can't inject markup.
 */
const md = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    html(token: Tokens.HTML | Tokens.Tag) { return 'block' in token && token.block ? `<p>${escapeHtml(token.text.trim()).replace(/\n/g, '<br>')}</p>\n` : escapeHtml(token.text); },
    link(token: Tokens.Link) {
      const text = this.parser.parseInline(token.tokens);
      if (!/^(https?:|mailto:)/i.test(token.href)) return text;
      return `<a href="${escapeHtml(token.href)}">${text}</a>`;
    },
    image(token: Tokens.Image) {
      return /^https?:/i.test(token.href) ? `<img src="${escapeHtml(token.href)}" alt="${escapeHtml(token.text)}" style="max-width:100%">` : escapeHtml(token.text);
    },
  },
});

export function markdownToHtml(text: string): string {
  if (looksLikeHtml(text)) return text;
  return (md.parse(text ?? '', { async: false }) as string).trim();
}
