import { Fragment, type ReactNode } from 'react';
import { Link } from 'react-router';

/**
 * Small markdown renderer for agent replies: headings, lists, code blocks,
 * bold/italic/inline code and links (in-app paths use the router).
 */
export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('```')) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) code.push(lines[i++]);
      i++;
      blocks.push(<pre key={blocks.length} className="my-2 overflow-x-auto rounded-md bg-zinc-50 px-3 py-2 font-mono text-[12px] leading-relaxed text-zinc-800 ring-1 ring-zinc-200/70">{code.join('\n')}</pre>);
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      blocks.push(<div key={blocks.length} className={h[1].length <= 2 ? 'mb-1 mt-3 text-[14.5px] font-semibold text-zinc-900' : 'mb-1 mt-2.5 text-[13.5px] font-semibold text-zinc-900'}>{inline(h[2])}</div>);
      i++;
      continue;
    }
    if (/^\s*([-*•]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]/.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*([-*•]|\d+[.)])\s+/, ''));
        i++;
      }
      const L = ordered ? 'ol' : 'ul';
      blocks.push(<L key={blocks.length} className={`my-1.5 space-y-0.5 pl-5 ${ordered ? 'list-decimal' : 'list-disc'} marker:text-zinc-400`}>{items.map((it, k) => <li key={k}>{inline(it)}</li>)}</L>);
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|\s*([-*•]|\d+[.)])\s+)/.test(lines[i])) para.push(lines[i++]);
    blocks.push(<p key={blocks.length} className="my-1.5">{para.map((p, k) => <Fragment key={k}>{k > 0 && <br />}{inline(p)}</Fragment>)}</p>);
  }
  return <div className="text-[13.5px] leading-relaxed text-zinc-800">{blocks}</div>;
}

function inline(s: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)\s]+\)|\*[^*\s][^*]*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    const t = m[0];
    const key = out.length;
    if (t.startsWith('`')) out.push(<code key={key} className="rounded bg-zinc-100 px-1 py-px font-mono text-[12px] text-zinc-800">{t.slice(1, -1)}</code>);
    else if (t.startsWith('**')) out.push(<strong key={key} className="font-semibold text-zinc-900">{t.slice(2, -2)}</strong>);
    else if (t.startsWith('[')) {
      const [, label, href] = t.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/)!;
      out.push(href.startsWith('/')
        ? <Link key={key} to={href} className="font-medium text-brand-600 hover:underline">{label}</Link>
        : <a key={key} href={href} target="_blank" rel="noreferrer" className="font-medium text-brand-600 hover:underline">{label}</a>);
    } else out.push(<em key={key}>{t.slice(1, -1)}</em>);
    last = m.index + t.length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}
