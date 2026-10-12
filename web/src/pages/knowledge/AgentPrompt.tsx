/**
 * "@Agent" in a Knowledge Hub document: the "@" mention menu (TipTap suggestion
 * plugin) and the inline prompt box. The agent gets the whole document, the text
 * around the cursor (or the selection), and returns markdown, which goes into the
 * editor as one transaction — a single undo step.
 */
import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { Extension, type Editor, type Range } from '@tiptap/core';
import { DOMSerializer } from '@tiptap/pm/model';
import Suggestion, { type SuggestionKeyDownProps, type SuggestionProps } from '@tiptap/suggestion';
import { CornerDownLeft, MessageSquareText, X } from 'lucide-react';
import { Shimmer, cx, useUi } from '../../components/ui.tsx';
import { htmlToMarkdown, markdownToHtml } from './markdown.ts';

export interface MentionItem { id: string; label: string; hint: string }
export const MENTION_ITEMS: MentionItem[] = [{ id: 'agent', label: 'Agent', hint: 'Ask the agent to write or research here' }];

/** What the editor component plugs into the suggestion plugin. Kept in a ref so handlers see fresh state. */
export interface MentionBridge {
  open: (p: SuggestionProps<MentionItem>) => void;
  update: (p: SuggestionProps<MentionItem>) => void;
  close: () => void;
  key: (e: KeyboardEvent) => boolean;
  choose: (item: MentionItem, at: number) => void;
}

export function agentMention(bridge: MutableRefObject<MentionBridge | null>) {
  return Extension.create({
    name: 'agentMention',
    addProseMirrorPlugins() {
      return [Suggestion<MentionItem, MentionItem>({
        editor: this.editor,
        char: '@',
        items: ({ query }) => MENTION_ITEMS.filter((i) => i.label.toLowerCase().startsWith(query.toLowerCase())),
        command: ({ editor, range, props }) => {
          editor.chain().focus().deleteRange(range).run();
          bridge.current?.choose(props, range.from);
        },
        render: () => ({
          onStart: (p) => bridge.current?.open(p),
          onUpdate: (p) => bridge.current?.update(p),
          onExit: () => bridge.current?.close(),
          onKeyDown: ({ event }: SuggestionKeyDownProps) => bridge.current?.key(event) ?? false,
        }),
      })];
    },
  });
}

/** The "@" menu, under the caret. */
export function MentionMenu({ state, index, onPick }: { state: SuggestionProps<MentionItem>; index: number; onPick: (i: MentionItem) => void }) {
  const rect = state.clientRect?.();
  if (!rect || !state.items.length) return null;
  return (
    <div role="listbox" className="fixed z-40 w-64 rounded-lg border border-zinc-200 bg-white p-1 shadow-lg" style={{ top: rect.bottom + 6, left: rect.left }}>
      {state.items.map((it, i) => (
        <button key={it.id} role="option" aria-selected={i === index} onMouseDown={(e) => { e.preventDefault(); onPick(it); }}
          className={cx('flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left', i === index ? 'bg-zinc-100' : 'hover:bg-zinc-50')}>
          <span className="flex size-6 shrink-0 items-center justify-center rounded-md border border-zinc-200 bg-white text-zinc-500"><MessageSquareText className="size-3.5" /></span>
          <span className="min-w-0">
            <span className="block text-[13px] font-medium text-zinc-900">{it.label}</span>
            <span className="block truncate text-[11.5px] text-zinc-400">{it.hint}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

type Mode = 'auto' | 'insert' | 'replace' | 'append' | 'rewrite';
const MODES: { id: Mode; label: string }[] = [
  { id: 'auto', label: 'Auto' }, { id: 'insert', label: 'Insert here' }, { id: 'replace', label: 'Replace selection' },
  { id: 'append', label: 'Append section' }, { id: 'rewrite', label: 'Rewrite doc' },
];

export interface PromptAnchor { pos: number; from: number; to: number }

/** Markdown of a range of the document (via the editor's own HTML serialisation). */
function rangeMarkdown(editor: Editor, from: number, to: number): string {
  if (to <= from) return '';
  const frag = DOMSerializer.fromSchema(editor.schema).serializeFragment(editor.state.doc.slice(from, to).content);
  const div = document.createElement('div');
  div.appendChild(frag);
  return htmlToMarkdown(div.innerHTML);
}

/** POST with a server-sent-events response; calls onEvent for each `data:` line. */
async function streamPost(url: string, body: unknown, signal: AbortSignal, onEvent: (e: any) => void) {
  const res = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
  if (!res.ok || !res.body) {
    const j = await res.json().catch(() => null);
    throw new Error(j?.message ?? `Request failed (${res.status})`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (chunk.startsWith('data: ')) onEvent(JSON.parse(chunk.slice(6)));
    }
  }
}

/** The inline prompt box: instruction, placement, then the agent's steps as shimmer text. */
export function AgentPrompt({ editor, docId, anchor, top, onClose }: { editor: Editor; docId: number; anchor: PromptAnchor; top: number; onClose: () => void }) {
  const { confirm, toast } = useUi();
  const hasSelection = anchor.to > anchor.from;
  const [text, setText] = useState('');
  const [mode, setMode] = useState<Mode>(hasSelection ? 'replace' : 'auto');
  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => () => { abort.current?.abort(); if (!editor.isDestroyed) editor.setEditable(true); }, [editor]);

  const cancel = () => {
    abort.current?.abort();
    if (!editor.isDestroyed) editor.setEditable(true);
    onClose();
    editor.commands.focus();
  };

  const apply = async (markdown: string, m: Exclude<Mode, 'auto'>) => {
    const html = markdownToHtml(markdown);
    const { doc } = editor.state;
    if (m === 'rewrite' && mode !== 'rewrite') {
      editor.setEditable(true);
      if (!(await confirm({ title: 'Rewrite the whole document?', message: 'The agent rewrote the entire document. Replace it? You can undo afterwards.', confirmLabel: 'Replace document' }))) return false;
    }
    editor.setEditable(true);
    const chain = editor.chain().focus();
    if (m === 'rewrite') chain.insertContentAt({ from: 0, to: doc.content.size }, html);
    else if (m === 'append') chain.insertContentAt(doc.content.size, html);
    else if (m === 'replace' && hasSelection) chain.insertContentAt({ from: anchor.from, to: anchor.to }, html);
    else {
      // At the cursor: an empty paragraph (typical after typing "@") is replaced; otherwise the text goes after its block.
      // Inside a table: a returned table replaces it ("fill this table"), anything else goes after it.
      const $pos = doc.resolve(Math.min(anchor.pos, doc.content.size));
      let table = 0;
      for (let d = $pos.depth; d > 0; d--) if ($pos.node(d).type.name === 'table') { table = d; break; }
      if (table) chain.insertContentAt(/^\s*\|/.test(markdown) ? { from: $pos.before(table), to: $pos.after(table) } : $pos.after(table), html);
      else if ($pos.depth > 0 && $pos.parent.isTextblock && $pos.parent.content.size === 0) chain.insertContentAt({ from: $pos.before(), to: $pos.after() }, html);
      else if ($pos.depth === 1 && $pos.parent.isTextblock) chain.insertContentAt($pos.after(1), html);
      else chain.insertContentAt(anchor.pos, html);
    }
    chain.run();
    return true;
  };

  const submit = async () => {
    const instruction = text.trim();
    if (!instruction || step) return;
    setError(null);
    setStep('Agent is writing…');
    editor.setEditable(false);
    const ctrl = new AbortController();
    abort.current = ctrl;
    const { doc } = editor.state;
    const body = {
      instruction, stream: true, mode: mode === 'replace' && !hasSelection ? 'auto' : mode,
      content: htmlToMarkdown(editor.getHTML()),
      ...(hasSelection ? { selection: rangeMarkdown(editor, anchor.from, anchor.to) } : { before: rangeMarkdown(editor, 0, anchor.pos), after: rangeMarkdown(editor, anchor.pos, doc.content.size) }),
    };
    try {
      let result: { markdown: string; mode: Exclude<Mode, 'auto'>; note?: string } | null = null;
      await streamPost(`/api/knowledge/docs/${docId}/agent`, body, ctrl.signal, (e) => {
        if (e.type === 'step') setStep(e.label === 'Thinking…' ? 'Agent is writing…' : e.label);
        if (e.type === 'done') result = e.data;
        if (e.type === 'error') throw new Error(e.message);
      });
      if (!result) throw new Error('The agent stopped without writing anything.');
      const r = result as { markdown: string; mode: Exclude<Mode, 'auto'>; note?: string };
      if (await apply(r.markdown, r.mode)) {
        onClose();
        if (r.note) toast(r.note);
      } else {
        setStep(null);
      }
    } catch (e: any) {
      if (ctrl.signal.aborted) return;
      editor.setEditable(true);
      setStep(null);
      setError(e?.message ?? String(e));
    }
  };

  return (
    <div className="absolute inset-x-0 z-30" style={{ top }} onMouseDown={(e) => e.stopPropagation()}>
      <div className="rounded-lg border border-zinc-200 bg-white shadow-lg">
        <div className="flex items-center gap-2 px-2.5 py-2">
          <span className="flex shrink-0 items-center gap-1.5 rounded-md bg-zinc-100 px-1.5 py-0.5 text-[12px] font-medium text-zinc-700"><MessageSquareText className="size-3.5 text-zinc-500" />Agent</span>
          {step ? (
            <Shimmer className="flex-1 truncate text-[13.5px]">{step}</Shimmer>
          ) : (
            <input ref={input} value={text} onChange={(e) => setText(e.target.value)} aria-label="Instruction for the agent"
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submit(); } if (e.key === 'Escape') { e.preventDefault(); cancel(); } }}
              placeholder={hasSelection ? 'What should the agent do with the selection?' : 'e.g. expand this section with examples, or fill this table with 5 competitors'}
              className="h-7 min-w-0 flex-1 border-none bg-transparent text-[13.5px] text-zinc-800 placeholder:text-zinc-400 focus:outline-none" />
          )}
          {!step && <button type="button" onClick={() => void submit()} disabled={!text.trim()} title="Send (Enter)" aria-label="Send"
            className="inline-flex size-7 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-100 disabled:opacity-30"><CornerDownLeft className="size-4" /></button>}
          <button type="button" onClick={cancel} title="Cancel (Esc)" aria-label="Cancel" className="inline-flex size-7 items-center justify-center rounded-md text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"><X className="size-4" /></button>
        </div>
        {!step && (
          <div className="flex flex-wrap items-center gap-1 border-t border-zinc-100 px-2.5 py-1.5">
            {MODES.filter((m) => m.id !== 'replace' || hasSelection).map((m) => (
              <button key={m.id} type="button" onClick={() => { setMode(m.id); input.current?.focus(); }}
                className={cx('rounded-md px-2 py-0.5 text-[12px] transition-colors', mode === m.id ? 'bg-zinc-900 text-white' : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800')}>{m.label}</button>
            ))}
            <span className="ml-auto text-[11.5px] text-zinc-400">Enter to send · Esc to cancel</span>
          </div>
        )}
        {error && <p className="border-t border-zinc-100 px-3 py-1.5 text-[12.5px] text-red-600">{error}</p>}
      </div>
    </div>
  );
}
