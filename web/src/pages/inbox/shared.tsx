import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, Eye, File, FileArchive, FileImage, FileSpreadsheet, FileText, ImageOff, Paperclip, X } from 'lucide-react';
import { cx, Textarea } from '../../components/ui.tsx';
import { emailMarkdownToHtml } from '../../lib/emailMarkdown.ts';
import { fileToBase64 } from '../leads/types.ts';

/** Converts HTML to readable text without executing anything (DOMParser is inert). */
export function htmlText(html: string): string {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|tr|h\d)>/gi, '\n\n'), 'text/html');
  return (doc.body.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim();
}

/** Splits a plain-text email into the new part and the quoted history. */
export function splitQuoted(text: string): { main: string; quoted: string } {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let cut = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (/^On .{4,300}wrote:\s*$/.test(l) || /^-{2,}\s*(Original|Forwarded) Message/i.test(l) || (/^>/.test(l) && lines.slice(i).every((x) => x.startsWith('>') || !x.trim()))) {
      cut = i;
      break;
    }
    // "On Mon, ... <x@y>" sometimes wraps onto the next line before "wrote:"
    if (/^On .{4,200}$/.test(l) && /wrote:\s*$/.test(lines[i + 1] ?? '')) { cut = i; break; }
  }
  if (cut <= 0) return { main: text.trim(), quoted: cut === 0 ? text.trim() : '' };
  return { main: lines.slice(0, cut).join('\n').trim(), quoted: lines.slice(cut).join('\n').trim() };
}

export function EmailText({ text, html }: { text?: string | null; html?: string | null }) {
  const [showQuoted, setShowQuoted] = useState(false);
  const body = useMemo(() => (text && text.trim() ? text : htmlText(html ?? '')), [text, html]);
  const { main, quoted } = useMemo(() => splitQuoted(body), [body]);
  return (
    <div className="text-sm leading-relaxed text-slate-800">
      <div className="whitespace-pre-wrap break-words">{main ? <Linkified text={main} /> : <span className="text-slate-400">(empty message)</span>}</div>
      {quoted && (
        <>
          <button onClick={() => setShowQuoted((s) => !s)} className="mt-2 rounded bg-slate-100 px-2 text-xs font-medium tracking-widest text-slate-500 hover:bg-slate-200" title={showQuoted ? 'Hide quoted text' : 'Show quoted text'}>•••</button>
          {showQuoted && <div className="mt-2 whitespace-pre-wrap break-words border-l-2 border-slate-200 pl-3 text-slate-500"><Linkified text={quoted} /></div>}
        </>
      )}
    </div>
  );
}

function Linkified({ text }: { text: string }) {
  const parts = text.split(/(\bhttps?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]'])/g);
  return <>{parts.map((p, i) => (i % 2 ? <a key={i} href={p} target="_blank" rel="noreferrer noopener" className="text-brand-600 hover:underline">{p}</a> : p))}</>;
}

/** Quoted history as Gmail, Apple Mail, Outlook, Yahoo and Thunderbird mark it in HTML. */
const QUOTE_SEL = '.gmail_quote, blockquote[type="cite"], .yahoo_quoted, #divRplyFwdMsg, #divRplyFwdMsg ~ *, #appendonsend, #appendonsend ~ *, .moz-cite-prefix, .moz-cite-prefix ~ blockquote';
const REMOTE = /(?:\ssrc|\sbackground|\ssrcset)\s*=\s*["']?\s*(?:https?:)?\/\/|url\(\s*["']?\s*(?:https?:)?\/\//i;
const FRAME_CSS = `html,body{margin:0;padding:0;background:transparent}
body{font:14px/1.6 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:#1e293b;word-break:break-word;overflow-x:auto;overflow-y:hidden}
img{max-width:100%;height:auto}a{color:#2563eb}p{margin:0 0 .75em}pre{white-space:pre-wrap}ul,ol{padding-left:1.5em}
blockquote{margin:0 0 0 .8ex;border-left:2px solid #e2e8f0;padding-left:1ex;color:#64748b}`;

/**
 * Shows an email's HTML with its formatting, safely: a sandboxed frame with no scripts,
 * forms or navigation, links opening in a new tab, and remote images (tracking pixels)
 * blocked until "Show images". Quoted history is folded behind "•••".
 */
export function EmailHtml({ html, collapseQuotes = true }: { html: string; collapseQuotes?: boolean }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(24);
  const [showImages, setShowImages] = useState(false);
  const [showQuoted, setShowQuoted] = useState(false);
  const clean = useMemo(() => html.replace(/<meta[^>]*http-equiv[^>]*>/gi, '').replace(/<script[\s\S]*?<\/script\s*>/gi, ''), [html]);
  const hasRemote = useMemo(() => REMOTE.test(clean), [clean]);
  // Only fold quotes when something is left to show (a bare forward is all "quote").
  const hasQuote = useMemo(() => {
    if (!collapseQuotes) return false;
    const d = new DOMParser().parseFromString(clean, 'text/html');
    const q = d.querySelectorAll(QUOTE_SEL);
    if (!q.length) return false;
    q.forEach((el) => el.remove());
    return !!(d.body.textContent ?? '').trim() || !!d.body.querySelector('img');
  }, [clean, collapseQuotes]);

  const remote = showImages ? ' https: http:' : '';
  const csp = `default-src 'none'; img-src data:${remote}; style-src 'unsafe-inline'${remote}; font-src data:${remote}`;
  const srcDoc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><base target="_blank">`
    + `<style>${FRAME_CSS}${hasQuote && !showQuoted ? `${QUOTE_SEL}{display:none!important}` : ''}`
    // Blocked web images keep their space but don't show a broken-image icon.
    + `${hasRemote && !showImages ? 'img[src^="http"],img[src^="//"]{visibility:hidden}' : ''}</style></head><body>${clean}</body></html>`;

  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    let ro: ResizeObserver | null = null;
    const measure = () => { const d = frame.contentDocument; if (d?.documentElement) setHeight(Math.max(d.documentElement.scrollHeight, d.body?.scrollHeight ?? 0)); };
    const onLoad = () => {
      measure();
      ro?.disconnect();
      const body = frame.contentDocument?.body;
      if (body) { ro = new ResizeObserver(measure); ro.observe(body); }
    };
    frame.addEventListener('load', onLoad);
    return () => { frame.removeEventListener('load', onLoad); ro?.disconnect(); };
  }, []);

  return (
    <div>
      {hasRemote && !showImages && (
        <div className="mb-2 flex items-center gap-2 rounded-md bg-slate-50 px-2.5 py-1.5 text-xs text-slate-500">
          <ImageOff className="size-3.5" /> Images from the web are hidden to stop tracking.
          <button onClick={() => setShowImages(true)} className="font-medium text-brand-600 hover:underline">Show images</button>
        </div>
      )}
      <iframe ref={ref} title="Email" srcDoc={srcDoc} sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        className="block w-full border-0" style={{ height }} />
      {hasQuote && (
        <button onClick={() => setShowQuoted((v) => !v)} className="mt-2 rounded bg-slate-100 px-2 text-xs font-medium tracking-widest text-slate-500 hover:bg-slate-200" title={showQuoted ? 'Hide quoted text' : 'Show quoted text'}>•••</button>
      )}
    </div>
  );
}

/** An email body: its HTML when it has one, otherwise the plain text. */
export function EmailBody({ text, html }: { text?: string | null; html?: string | null }) {
  return html && html.trim() ? <EmailHtml html={html} /> : <EmailText text={text} html={html} />;
}

export interface AttachmentItem { filename: string; size: number; url: string; content_type?: string; inline?: boolean }

const VIEWABLE = /^(image\/(png|jpeg|gif|webp|avif|bmp)|application\/pdf|text\/plain)/i;

export function fmtSize(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.ceil(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function fileIcon(a: AttachmentItem) {
  const t = a.content_type ?? '';
  const ext = a.filename.split('.').pop()?.toLowerCase() ?? '';
  if (t.startsWith('image/')) return FileImage;
  if (/sheet|excel|csv/.test(t) || ['csv', 'xls', 'xlsx', 'numbers'].includes(ext)) return FileSpreadsheet;
  if (/zip|compressed|tar|rar|7z/.test(t) || ['zip', 'rar', '7z', 'gz', 'tar'].includes(ext)) return FileArchive;
  if (/pdf|word|text|document|presentation/.test(t) || ['pdf', 'doc', 'docx', 'txt', 'rtf', 'ppt', 'pptx', 'key', 'pages'].includes(ext)) return FileText;
  return File;
}

/**
 * A message's attachments: images as thumbnails, everything else as a file chip. Images,
 * PDFs and text open in a new tab; the download button saves any file under its real name.
 * Inline images are left out when the email's HTML already shows them.
 */
export function AttachmentList({ items, hideInline, className }: { items?: AttachmentItem[]; hideInline?: boolean; className?: string }) {
  const shown = (items ?? []).filter((a) => !(hideInline && a.inline));
  if (!shown.length) return null;
  return (
    <div className={cx('flex flex-wrap gap-2', className)}>
      {shown.map((a) => {
        const viewable = VIEWABLE.test(a.content_type ?? '');
        const image = viewable && (a.content_type ?? '').startsWith('image/');
        const Icon = fileIcon(a);
        const open = viewable ? `${a.url}?inline=1` : a.url;
        return (
          <div key={a.url} className="group flex max-w-72 items-stretch overflow-hidden rounded-lg border border-slate-200 bg-white text-xs text-slate-700">
            <a href={open} target={viewable ? '_blank' : undefined} rel="noreferrer" download={viewable ? undefined : a.filename}
              className="flex min-w-0 items-center gap-2 px-2.5 py-1.5 hover:bg-slate-50" title={viewable ? `Open ${a.filename}` : `Download ${a.filename}`}>
              {image
                ? <img src={`${a.url}?inline=1`} alt="" loading="lazy" className="size-8 shrink-0 rounded object-cover" />
                : <Icon className="size-4 shrink-0 text-slate-400" />}
              <span className="min-w-0">
                <span className="block truncate font-medium">{a.filename}</span>
                <span className="block text-[11px] text-slate-400">{fmtSize(a.size)}</span>
              </span>
              {viewable && <Eye className="size-3.5 shrink-0 text-slate-300 group-hover:text-slate-500" />}
            </a>
            <a href={a.url} download={a.filename} className="flex items-center border-l border-slate-100 px-2 text-slate-400 hover:bg-slate-50 hover:text-slate-700" title={`Download ${a.filename}`} aria-label={`Download ${a.filename}`}>
              <Download className="size-3.5" />
            </a>
          </div>
        );
      })}
    </div>
  );
}

/** Message box that takes Markdown (**bold**, _italic_, [link](url), - lists), with a preview of the formatted email. */
export function MarkdownEditor({ value, onChange, rows = 6, placeholder, onKeyDown, className, autoFocus }: {
  value: string; onChange: (v: string) => void; rows?: number; placeholder?: string; className?: string; autoFocus?: boolean;
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
}) {
  const [preview, setPreview] = useState(false);
  const html = useMemo(() => (preview ? emailMarkdownToHtml(value) : ''), [preview, value]);
  return (
    <div>
      {preview ? (
        <div className="overflow-auto rounded-lg border border-slate-200 bg-white px-3 py-2" style={{ minHeight: `${rows * 1.5 + 1}rem` }}>
          {value.trim() ? <EmailHtml html={html} collapseQuotes={false} /> : <span className="text-sm text-slate-400">Nothing to preview yet.</span>}
        </div>
      ) : (
        <Textarea rows={rows} className={className} placeholder={placeholder} value={value} autoFocus={autoFocus} onChange={(e) => onChange(e.target.value)} onKeyDown={onKeyDown} />
      )}
      <div className="mt-1 flex items-center gap-2 text-[11.5px] text-slate-400">
        <span className="truncate" title="Markdown: **bold**, _italic_, [link text](https://…), - bullet list, 1. numbered list, > quote">
          Markdown works: <code>**bold**</code> <code>_italic_</code> <code>[link](url)</code> <code>- list</code>
        </span>
        <button type="button" onClick={() => setPreview((p) => !p)} className="ml-auto shrink-0 rounded px-1.5 py-0.5 font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-800">
          {preview ? 'Edit' : 'Preview'}
        </button>
      </div>
    </div>
  );
}

export interface PendingAttachment { filename: string; content_base64: string; content_type?: string; size: number }

export function useAttachments() {
  const [files, setFiles] = useState<PendingAttachment[]>([]);
  const add = async (list: FileList | null) => {
    if (!list) return;
    const out: PendingAttachment[] = [];
    for (const f of Array.from(list)) out.push({ filename: f.name, content_base64: await fileToBase64(f), content_type: f.type || undefined, size: f.size });
    setFiles((cur) => [...cur, ...out]);
  };
  const remove = (i: number) => setFiles((cur) => cur.filter((_, j) => j !== i));
  const payload = () => files.map(({ size: _s, ...f }) => f);
  const totalSize = files.reduce((n, f) => n + f.size, 0);
  return { files, add, remove, clear: () => setFiles([]), payload, totalSize };
}

export function AttachmentPicker({ att, className }: { att: ReturnType<typeof useAttachments>; className?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div className={cx('flex flex-wrap items-center gap-2', className)}>
      <button type="button" onClick={() => ref.current?.click()} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[13px] text-slate-600 hover:bg-slate-100" title="Attach files">
        <Paperclip className="size-4" /> Attach
      </button>
      <input ref={ref} type="file" multiple className="hidden" onChange={(e) => { att.add(e.target.files); e.target.value = ''; }} />
      {att.files.map((f, i) => (
        <span key={i} className="inline-flex items-center gap-1 rounded-md bg-slate-100 py-0.5 pl-2 pr-1 text-xs text-slate-700">
          {f.filename} <span className="text-slate-400">{Math.ceil(f.size / 1024)} KB</span>
          <button onClick={() => att.remove(i)} className="rounded p-0.5 hover:bg-slate-200" aria-label={`Remove ${f.filename}`}><X className="size-3" /></button>
        </span>
      ))}
      {att.totalSize > 15 * 1024 * 1024 && <span className="text-xs text-red-600">Attachments are limited to 15 MB in total.</span>}
    </div>
  );
}

export const parseEmails = (s: string) => s.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
