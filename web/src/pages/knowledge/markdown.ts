/**
 * Markdown <-> HTML for the Knowledge Hub editor. Docs are stored as markdown (the
 * agent reads and writes it, and it suits prompts); TipTap edits HTML. marked turns
 * markdown into HTML TipTap understands (task lists use TipTap's data-type markup);
 * turndown turns the editor's HTML back into tidy GFM markdown.
 */
import { Marked, type Tokens } from 'marked';
import TurndownService from 'turndown';

const marked = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    list(token: Tokens.List) {
      if (!token.items.some((i) => i.task)) return false; // default rendering
      const items = token.items.map((i) => {
        const inner = this.parser.parse(i.tokens.filter((t) => t.type !== 'checkbox'));
        return `<li data-type="taskItem" data-checked="${i.checked ? 'true' : 'false'}">${inner}</li>`;
      });
      return `<ul data-type="taskList">${items.join('')}</ul>\n`;
    },
  },
});

export function markdownToHtml(md: string): string {
  return marked.parse(md ?? '', { async: false }) as string;
}

let td: TurndownService | null = null;

/** Item content without outer blank lines, and no blank line before a nested list. */
const tightNested = (content: string) => content.replace(/^\n+/, '').replace(/\n+$/, '\n').replace(/\n{2,}(?=(?:[-*+]|\d+\.) )/g, '\n');

function turndown(): TurndownService {
  if (td) return td;
  td = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced', emDelimiter: '_', strongDelimiter: '**', hr: '---' });
  td.addRule('strike', { filter: ['s', 'del'] as any, replacement: (c) => (c.trim() ? `~~${c}~~` : '') });
  // Later rules win in turndown, so task items come after plain items.
  // Plain list items with a single-space marker ("- a", "1. a") instead of turndown's "-   a".
  td.addRule('listItem', {
    filter: 'li',
    replacement: (content, node) => {
      const parent = node.parentNode as HTMLElement;
      let prefix = '- ';
      if (parent.nodeName === 'OL') {
        const start = Number(parent.getAttribute('start') || 1);
        prefix = `${start + Array.prototype.indexOf.call(parent.children, node)}. `;
      }
      const body = tightNested(content).replace(/\n/gm, `\n${' '.repeat(prefix.length)}`);
      return prefix + body.trimEnd() + (node.nextSibling ? '\n' : '');
    },
  });
  // Task items: "- [x] text"; the checkbox <label> carries no text.
  td.addRule('taskItem', {
    filter: (n) => n.nodeName === 'LI' && n.getAttribute('data-type') === 'taskItem',
    replacement: (content, node) => {
      const el = node as HTMLElement;
      const checked = el.getAttribute('data-checked') === 'true';
      const body = tightNested(content).replace(/\n/gm, '\n      ');
      return `- [${checked ? 'x' : ' '}] ${body.trimEnd()}${el.nextSibling ? '\n' : ''}`;
    },
  });
  td.addRule('taskLabel', { filter: (n) => n.nodeName === 'LABEL' && !!n.parentElement?.getAttribute('data-type'), replacement: () => '' });
  // GFM tables. The first row is always the header row (markdown tables need one); cells keep
  // inline formatting, line breaks and paragraphs inside a cell become <br>, pipes are escaped.
  td.addRule('tableCell', {
    filter: ['th', 'td'],
    replacement: (content) => `| ${content.trim().replace(/\s*\n+\s*/g, '<br>').replace(/(^|[^\\])\|/g, '$1\\|')} `,
  });
  td.addRule('tableRow', {
    filter: 'tr',
    replacement: (content, node) => {
      const row = `${content}|`;
      let table: Node | null = node.parentNode;
      while (table && table.nodeName !== 'TABLE') table = table.parentNode;
      const first = table && (table as HTMLElement).querySelector('tr') === node;
      const cells = Array.prototype.filter.call(node.childNodes, (c: Node) => c.nodeName === 'TH' || c.nodeName === 'TD').length;
      return `\n${row}${first ? `\n|${' --- |'.repeat(cells)}` : ''}`;
    },
  });
  td.addRule('tableSection', { filter: ['thead', 'tbody', 'tfoot'], replacement: (content) => content });
  td.addRule('tableColumns', { filter: (n) => n.nodeName === 'COLGROUP' || n.nodeName === 'COL', replacement: () => '' });
  td.addRule('table', { filter: 'table', replacement: (content) => `\n\n${content.replace(/^\n+|\n+$/g, '')}\n\n` });
  return td;
}

export function htmlToMarkdown(html: string): string {
  const md = turndown().turndown(html ?? '');
  return md.replace(/\n{3,}/g, '\n\n').trim();
}
