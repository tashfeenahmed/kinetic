/**
 * Rich-text editor for Knowledge Hub docs (TipTap, MIT). Loaded lazily: the page
 * keeps markdown, this component converts on the way in and out. Markdown shortcuts
 * ("# ", "- ", "1. ", "[ ] ", "> ", "```") come from StarterKit and TaskItem; tables
 * from the table extension (stored as GFM tables). Typing "@" offers the Agent.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Placeholder } from '@tiptap/extensions';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import type { SuggestionProps } from '@tiptap/suggestion';
import {
  BetweenHorizontalEnd, BetweenHorizontalStart, BetweenVerticalEnd, BetweenVerticalStart, Bold, Code, Columns3, Heading1, Heading2, Heading3, Italic, Link2, List,
  ListOrdered, ListTodo, MessageSquareText, Minus, PanelTop, Quote, Redo2, Rows3, SquareCode, Strikethrough, Table as TableIcon, Trash2, Undo2,
} from 'lucide-react';
import { cx } from '../../components/ui.tsx';
import { htmlToMarkdown, markdownToHtml } from './markdown.ts';
import { AgentPrompt, MentionMenu, agentMention, type MentionBridge, type MentionItem, type PromptAnchor } from './AgentPrompt.tsx';
import './knowledge.css';

const extensions = (placeholder: string) => [
  StarterKit.configure({
    heading: { levels: [1, 2, 3] },
    underline: false, // no markdown for it
    link: { openOnClick: false, autolink: true, defaultProtocol: 'https', HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: '_blank' } },
  }),
  TaskList,
  TaskItem.configure({ nested: true }),
  Table.configure({ resizable: false }),
  TableRow,
  TableHeader,
  TableCell,
  Placeholder.configure({ placeholder: ({ node }) => (node.type.name === 'heading' ? 'Heading' : placeholder) }),
];

export default function DocEditor({ markdown, onChange, autoFocus, docId }: { markdown: string; onChange: (md: string) => void; autoFocus?: boolean; docId?: number }) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const bridge = useRef<MentionBridge | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<SuggestionProps<MentionItem> | null>(null);
  const [menuIndex, setMenuIndex] = useState(0);
  const [prompt, setPrompt] = useState<(PromptAnchor & { top: number }) | null>(null);
  const editor = useEditor({
    extensions: [...extensions(docId ? 'Write, or type @ to ask the agent, # for a heading, - for a list…' : 'Write, or type # for a heading, - for a list, [ ] for a task…'), ...(docId ? [agentMention(bridge)] : [])],
    content: markdownToHtml(markdown),
    autofocus: autoFocus ? 'end' : false,
    onUpdate: ({ editor: e }) => onChangeRef.current(htmlToMarkdown(e.getHTML())),
  });

  /** Opens the prompt box under the cursor (or the selection). */
  const openPrompt = (e: Editor, pos: number, from = pos, to = pos) => {
    const box = wrap.current?.getBoundingClientRect();
    let top = 0;
    try { top = e.view.coordsAtPos(Math.max(from, Math.min(to, e.state.doc.content.size))).bottom - (box?.top ?? 0) + 6; } catch { /* end of doc */ }
    setPrompt({ pos, from, to, top });
  };
  bridge.current = {
    open: (p) => { setMenu(p); setMenuIndex(0); },
    update: (p) => { setMenu(p); setMenuIndex((i) => Math.min(i, Math.max(0, p.items.length - 1))); },
    close: () => setMenu(null),
    key: (ev) => {
      if (!menu?.items.length) return false;
      if (ev.key === 'ArrowDown') { setMenuIndex((i) => (i + 1) % menu.items.length); return true; }
      if (ev.key === 'ArrowUp') { setMenuIndex((i) => (i - 1 + menu.items.length) % menu.items.length); return true; }
      if (ev.key === 'Enter' || ev.key === 'Tab') { menu.command(menu.items[menuIndex]); return true; }
      if (ev.key === 'Escape') { setMenu(null); return true; }
      return false;
    },
    choose: (_item, at) => { setMenu(null); if (editor) openPrompt(editor, at); },
  };

  if (!editor) return null;
  const askAgent = () => {
    const { from, to } = editor.state.selection;
    openPrompt(editor, to, from, to);
  };
  return (
    <div className="kn-prose relative" ref={wrap}>
      <Toolbar editor={editor} onAskAgent={docId ? askAgent : undefined} />
      <EditorContent editor={editor} />
      {menu && <MentionMenu state={menu} index={menuIndex} onPick={(it) => menu.command(it)} />}
      {prompt && docId && <AgentPrompt key={`${prompt.pos}-${prompt.from}`} editor={editor} docId={docId} anchor={prompt} top={prompt.top} onClose={() => setPrompt(null)} />}
    </div>
  );
}

function Toolbar({ editor, onAskAgent }: { editor: Editor; onAskAgent?: () => void }) {
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      h1: e.isActive('heading', { level: 1 }), h2: e.isActive('heading', { level: 2 }), h3: e.isActive('heading', { level: 3 }),
      bold: e.isActive('bold'), italic: e.isActive('italic'), strike: e.isActive('strike'), code: e.isActive('code'),
      bullet: e.isActive('bulletList'), ordered: e.isActive('orderedList'), task: e.isActive('taskList'),
      quote: e.isActive('blockquote'), codeBlock: e.isActive('codeBlock'), link: e.isActive('link'), table: e.isActive('table'),
      undo: e.can().undo(), redo: e.can().redo(),
    }),
  });
  const [linking, setLinking] = useState(false);
  const c = () => editor.chain().focus();
  return (
    <div className="sticky top-0 z-10 -mx-2 mb-5 flex flex-wrap items-center gap-0.5 border-b border-zinc-100 bg-white/95 px-1 py-1.5 backdrop-blur">
      <Btn label="Heading 1" active={s.h1} onClick={() => c().toggleHeading({ level: 1 }).run()}><Heading1 /></Btn>
      <Btn label="Heading 2" active={s.h2} onClick={() => c().toggleHeading({ level: 2 }).run()}><Heading2 /></Btn>
      <Btn label="Heading 3" active={s.h3} onClick={() => c().toggleHeading({ level: 3 }).run()}><Heading3 /></Btn>
      <Sep />
      <Btn label="Bold (⌘B)" active={s.bold} onClick={() => c().toggleBold().run()}><Bold /></Btn>
      <Btn label="Italic (⌘I)" active={s.italic} onClick={() => c().toggleItalic().run()}><Italic /></Btn>
      <Btn label="Strikethrough" active={s.strike} onClick={() => c().toggleStrike().run()}><Strikethrough /></Btn>
      <Btn label="Inline code" active={s.code} onClick={() => c().toggleCode().run()}><Code /></Btn>
      <Btn label="Link" active={s.link || linking} onClick={() => setLinking((v) => !v)}><Link2 /></Btn>
      <Sep />
      <Btn label="Bulleted list" active={s.bullet} onClick={() => c().toggleBulletList().run()}><List /></Btn>
      <Btn label="Numbered list" active={s.ordered} onClick={() => c().toggleOrderedList().run()}><ListOrdered /></Btn>
      <Btn label="Task list" active={s.task} onClick={() => c().toggleTaskList().run()}><ListTodo /></Btn>
      <Sep />
      <Btn label="Quote" active={s.quote} onClick={() => c().toggleBlockquote().run()}><Quote /></Btn>
      <Btn label="Code block" active={s.codeBlock} onClick={() => c().toggleCodeBlock().run()}><SquareCode /></Btn>
      <Btn label="Divider" onClick={() => c().setHorizontalRule().run()}><Minus /></Btn>
      <Btn label={s.table ? 'In a table' : 'Insert table (3×3)'} active={s.table} onClick={() => { if (!s.table) c().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(); }}><TableIcon /></Btn>
      {s.table && <TableTools editor={editor} />}
      {onAskAgent && <><Sep /><Btn label="Ask the agent (or type @)" onClick={onAskAgent}><MessageSquareText /></Btn></>}
      <span className="flex-1" />
      <Btn label="Undo (⌘Z)" disabled={!s.undo} onClick={() => c().undo().run()}><Undo2 /></Btn>
      <Btn label="Redo (⇧⌘Z)" disabled={!s.redo} onClick={() => c().redo().run()}><Redo2 /></Btn>
      {linking && <LinkInput editor={editor} onDone={() => setLinking(false)} />}
    </div>
  );
}

/** Shown while the cursor is in a table. */
function TableTools({ editor }: { editor: Editor }) {
  const c = () => editor.chain().focus();
  return (
    <span className="flex items-center gap-0.5 rounded-md bg-zinc-50 px-0.5" role="group" aria-label="Table">
      <Btn label="Add row above" onClick={() => c().addRowBefore().run()}><BetweenHorizontalStart /></Btn>
      <Btn label="Add row below" onClick={() => c().addRowAfter().run()}><BetweenHorizontalEnd /></Btn>
      <Btn label="Add column left" onClick={() => c().addColumnBefore().run()}><BetweenVerticalStart /></Btn>
      <Btn label="Add column right" onClick={() => c().addColumnAfter().run()}><BetweenVerticalEnd /></Btn>
      <Btn label="Delete row" onClick={() => c().deleteRow().run()}><Rows3 /></Btn>
      <Btn label="Delete column" onClick={() => c().deleteColumn().run()}><Columns3 /></Btn>
      <Btn label="Toggle header row" onClick={() => c().toggleHeaderRow().run()}><PanelTop /></Btn>
      <Btn label="Delete table" onClick={() => c().deleteTable().run()}><Trash2 /></Btn>
    </span>
  );
}

function LinkInput({ editor, onDone }: { editor: Editor; onDone: () => void }) {
  const [url, setUrl] = useState(() => editor.getAttributes('link').href ?? '');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  const apply = () => {
    const href = url.trim();
    const chain = editor.chain().focus().extendMarkRange('link');
    if (!href) chain.unsetLink().run();
    else if (editor.state.selection.empty && !editor.isActive('link')) editor.chain().focus().insertContent({ type: 'text', text: href, marks: [{ type: 'link', attrs: { href } }] }).run();
    else chain.setLink({ href: /^[a-z]+:/i.test(href) ? href : `https://${href}` }).run();
    onDone();
  };
  return (
    <form className="flex w-full items-center gap-2 px-1 pb-0.5 pt-1.5" onSubmit={(e) => { e.preventDefault(); apply(); }}>
      <input ref={ref} value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && onDone()} placeholder="Paste a link and press Enter (empty removes it)"
        className="h-7 flex-1 rounded-md border border-zinc-200 px-2 text-[13px] text-zinc-800 placeholder:text-zinc-400 focus:border-zinc-400 focus:outline-none" />
      <button type="submit" className="h-7 rounded-md bg-zinc-900 px-2.5 text-[12.5px] font-medium text-white hover:bg-zinc-800">Apply</button>
    </form>
  );
}

function Btn({ label, active, disabled, onClick, children }: { label: string; active?: boolean; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" title={label} aria-label={label} aria-pressed={active} disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={onClick}
      className={cx('inline-flex size-7 items-center justify-center rounded-md transition-colors [&>svg]:size-[15px] disabled:opacity-30',
        active ? 'bg-zinc-200/70 text-zinc-900' : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900')}>
      {children}
    </button>
  );
}

const Sep = () => <span className="mx-1 h-4 w-px bg-zinc-200" />;

/** Read-only markdown preview (autofill review). Rendered through the editor schema, so raw HTML in drafts never runs. */
export function MarkdownPreview({ markdown, className }: { markdown: string; className?: string }) {
  const editor = useEditor({ editable: false, extensions: extensions(''), content: markdownToHtml(markdown) }, [markdown]);
  return <div className={cx('kn-prose kn-preview', className)}>{editor && <EditorContent editor={editor} />}</div>;
}
