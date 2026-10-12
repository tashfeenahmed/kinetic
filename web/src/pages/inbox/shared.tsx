import { useMemo, useRef, useState } from 'react';
import { Paperclip, X } from 'lucide-react';
import { cx } from '../../components/ui.tsx';
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
      <div className="whitespace-pre-wrap break-words">{main || <span className="text-slate-400">(empty message)</span>}</div>
      {quoted && (
        <>
          <button onClick={() => setShowQuoted((s) => !s)} className="mt-2 rounded bg-slate-100 px-2 text-xs font-medium tracking-widest text-slate-500 hover:bg-slate-200" title={showQuoted ? 'Hide quoted text' : 'Show quoted text'}>•••</button>
          {showQuoted && <div className="mt-2 whitespace-pre-wrap break-words border-l-2 border-slate-200 pl-3 text-slate-500">{quoted}</div>}
        </>
      )}
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
