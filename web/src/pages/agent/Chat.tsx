import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowUp, BookOpen, Check, ChevronDown, ChevronRight, Circle, Clock, ExternalLink, Globe, Hand, Loader2, Minus, PanelLeftClose, PanelLeft,
  Plus, Search, ShieldAlert, Sparkles, Square, Table2, Trash2, Wrench, X,
} from 'lucide-react';
import { api, errorMessage } from '../../lib/api.ts';
import { fmtRelative } from '../../lib/format.ts';
import { Button, cx, useUi } from '../../components/ui.tsx';
import { Markdown } from './Markdown.tsx';
import type { AgentConfig, AgentMessage, AgentSession } from './types.ts';

const STARTERS = [
  'Find 50 Irish POS companies and their CEO emails',
  'Build a table of SaaS companies hiring SDRs in the UK',
  'Draft a 3-step campaign for my latest table',
  'Fill in my Knowledge Hub from my website',
  'Summarise unread replies in my inbox',
];

export function useAgentConfig() {
  return useQuery({ queryKey: ['agent-config'], queryFn: () => api.get('/api/agent/config').then((r) => r.data as AgentConfig), staleTime: 5 * 60_000 });
}

/** Chat history (left) + conversation. */
export function AgentChat({ sessionId }: { sessionId: number | null }) {
  const [historyOpen, setHistoryOpen] = useState(() => localStorage.getItem('k:agent-history') !== 'closed');
  const toggleHistory = () => setHistoryOpen((o) => { localStorage.setItem('k:agent-history', o ? 'closed' : 'open'); return !o; });
  return (
    <div className="flex min-h-0 flex-1">
      {historyOpen && <History sessionId={sessionId} onClose={toggleHistory} />}
      <div className="flex min-w-0 flex-1 flex-col">
        {sessionId ? <Conversation key={sessionId} sessionId={sessionId} historyOpen={historyOpen} toggleHistory={toggleHistory} />
          : <NewChat historyOpen={historyOpen} toggleHistory={toggleHistory} />}
      </div>
    </div>
  );
}

function History({ sessionId, onClose }: { sessionId: number | null; onClose: () => void }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { confirm, toast } = useUi();
  const sessions = useQuery({ queryKey: ['agent-sessions'], queryFn: () => api.get('/api/agent/sessions').then((r) => r.data as AgentSession[]), refetchInterval: 15_000 });
  const remove = async (s: AgentSession) => {
    if (!(await confirm({ title: `Delete “${s.title}”?`, message: 'The conversation is deleted. Tables and campaigns it created are kept.', confirmLabel: 'Delete chat', danger: true }))) return;
    try {
      await api.del(`/api/agent/sessions/${s.id}`);
      await qc.invalidateQueries({ queryKey: ['agent-sessions'] });
      if (s.id === sessionId) navigate('/agent');
    } catch (e) { toast(errorMessage(e), 'error'); }
  };
  return (
    <aside className="flex w-[248px] shrink-0 flex-col border-r border-zinc-200/80 bg-[#fafafa]">
      <div className="flex h-11 items-center gap-1 px-2">
        <button onClick={() => navigate('/agent')} className="flex h-8 flex-1 items-center gap-2 rounded-[7px] px-2.5 text-[13px] font-medium text-zinc-700 hover:bg-zinc-200/50">
          <Plus className="size-4" /> New chat
        </button>
        <button onClick={onClose} className="rounded-md p-1.5 text-zinc-500 hover:bg-zinc-200/60" title="Hide chat history" aria-label="Hide chat history"><PanelLeftClose className="size-4" /></button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3 scroll-thin">
        {sessions.data?.length === 0 && <p className="px-2.5 py-2 text-[12.5px] text-zinc-400">No chats yet</p>}
        {sessions.data?.map((s) => (
          <div key={s.id} className={cx('group flex items-center rounded-[7px]', s.id === sessionId ? 'bg-white shadow-sm ring-1 ring-zinc-200' : 'hover:bg-zinc-200/50')}>
            <Link to={`/agent/${s.id}`} className="min-w-0 flex-1 px-2.5 py-1.5">
              <div className="flex items-center gap-1.5">
                {s.status === 'running' && <Loader2 className="size-3 shrink-0 animate-spin text-zinc-500" />}
                {s.status === 'waiting' && <Hand className="size-3 shrink-0 text-amber-500" />}
                <span className="truncate text-[13px] text-zinc-800">{s.title}</span>
              </div>
              <div className="text-[11.5px] text-zinc-400">{fmtRelative(s.updated_at)}</div>
            </Link>
            <button onClick={() => remove(s)} className="mr-1 hidden rounded p-1 text-zinc-400 hover:bg-zinc-200 hover:text-red-600 group-hover:block" title="Delete chat" aria-label="Delete chat"><Trash2 className="size-3.5" /></button>
          </div>
        ))}
      </div>
    </aside>
  );
}

function TopBar({ title, historyOpen, toggleHistory, right }: { title: string; historyOpen: boolean; toggleHistory: () => void; right?: ReactNode }) {
  return (
    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-zinc-100 px-3">
      {!historyOpen && <button onClick={toggleHistory} className="rounded-md p-1.5 text-zinc-500 hover:bg-zinc-100" title="Show chat history" aria-label="Show chat history"><PanelLeft className="size-4" /></button>}
      <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-zinc-800">{title}</span>
      {right}
    </div>
  );
}

function NewChat({ historyOpen, toggleHistory }: { historyOpen: boolean; toggleHistory: () => void }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { toast } = useUi();
  const config = useAgentConfig();
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState(false);
  const start = async (text: string) => {
    setBusy(true);
    try {
      const r = await api.post('/api/agent/sessions', { message: text, model: model || null });
      await qc.invalidateQueries({ queryKey: ['agent-sessions'] });
      navigate(`/agent/${r.data.id}`);
    } catch (e) { toast(errorMessage(e), 'error'); setBusy(false); }
  };
  return (
    <>
      <TopBar title="New chat" historyOpen={historyOpen} toggleHistory={toggleHistory} />
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-4 py-10">
        <div className="w-full max-w-[680px]">
          <div className="mb-6 text-center">
            <div className="mx-auto mb-3 flex size-10 items-center justify-center rounded-xl bg-zinc-900 text-white"><Sparkles className="size-5" /></div>
            <h1 className="text-[22px] font-semibold tracking-tight text-zinc-900">What should we build?</h1>
            <p className="mt-1 text-[13.5px] text-zinc-500">The agent builds tables, finds and enriches prospects, writes campaigns and triages replies — it asks before anything that sends, deletes or spends.</p>
          </div>
          {config.data && !config.data.aiReady && (
            <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-amber-900">
              Add an OpenRouter key (or a local model URL) on the <Link to="/integrations" className="font-medium underline">Integrations</Link> page to use the agent.
            </div>
          )}
          <Composer onSend={start} busy={busy} model={model} setModel={setModel} config={config.data} autoFocus />
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            {STARTERS.map((s) => (
              <button key={s} disabled={busy} onClick={() => start(s)} className="rounded-full border border-zinc-200 bg-white px-3 py-1.5 text-[12.5px] text-zinc-700 hover:border-zinc-300 hover:bg-zinc-50">{s}</button>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

function Composer({ onSend, onStop, busy, running, model, setModel, config, autoFocus, placeholder }: {
  onSend: (text: string) => void | Promise<void>; onStop?: () => void; busy?: boolean; running?: boolean;
  model: string; setModel: (m: string) => void; config?: AgentConfig; autoFocus?: boolean; placeholder?: string;
}) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);
  const send = () => {
    const t = text.trim();
    if (!t || busy || running) return;
    setText('');
    void onSend(t);
  };
  const defaultLabel = config ? `Default · ${config.defaultModel.split('/').pop()}` : 'Default model';
  return (
    <div className="rounded-xl border border-zinc-200 bg-white shadow-sm focus-within:border-zinc-300 focus-within:ring-2 focus-within:ring-zinc-900/5">
      <textarea
        ref={ref} rows={2} value={text} autoFocus={autoFocus} onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }}
        placeholder={placeholder ?? 'Ask the agent to build, enrich, find or draft…'}
        className="block w-full resize-none rounded-t-xl bg-transparent px-3.5 pt-3 text-[13.5px] text-zinc-900 placeholder:text-zinc-400 focus:outline-none"
      />
      <div className="flex items-center gap-2 px-2.5 pb-2.5 pt-1">
        <div className="relative">
          <select value={model} onChange={(e) => setModel(e.target.value)} title="Model for this chat"
            className="h-7 max-w-[220px] appearance-none truncate rounded-md border border-transparent bg-zinc-100 pl-2 pr-6 text-[12px] text-zinc-700 hover:bg-zinc-200/70 focus:outline-none">
            <option value="">{defaultLabel}</option>
            {config?.models.slice(0, 60).map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            {model && !config?.models.some((m) => m.id === model) && <option value={model}>{model}</option>}
          </select>
          <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 size-3.5 -translate-y-1/2 text-zinc-500" />
        </div>
        <span className="flex-1" />
        {running ? (
          <button onClick={onStop} className="flex size-8 items-center justify-center rounded-lg bg-zinc-900 text-white hover:bg-zinc-700" title="Stop" aria-label="Stop"><Square className="size-3.5 fill-current" /></button>
        ) : (
          <button onClick={send} disabled={!text.trim() || busy} className="flex size-8 items-center justify-center rounded-lg bg-zinc-900 text-white hover:bg-zinc-700 disabled:bg-zinc-200 disabled:text-zinc-400" title="Send (Enter)" aria-label="Send">
            {busy ? <Loader2 className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}
          </button>
        )}
      </div>
    </div>
  );
}

function useSessionStream(sessionId: number) {
  const qc = useQueryClient();
  useEffect(() => {
    const es = new EventSource(`/api/agent/sessions/${sessionId}/events`);
    es.onmessage = (ev) => {
      const e = JSON.parse(ev.data);
      qc.setQueryData<AgentSession>(['agent-session', sessionId], (old) => {
        if (!old) return old;
        if (e.type === 'session') return { ...old, ...e.data, messages: old.messages };
        if (e.type === 'message') {
          const msgs = old.messages ?? [];
          const i = msgs.findIndex((m) => m.id === e.data.id);
          return { ...old, messages: i >= 0 ? msgs.map((m) => (m.id === e.data.id ? e.data : m)) : [...msgs, e.data].sort((a, b) => a.id - b.id) };
        }
        return old;
      });
      if (e.type === 'session') {
        void qc.invalidateQueries({ queryKey: ['agent-sessions'] });
        if (e.data.status !== 'running') void qc.invalidateQueries({ queryKey: ['gtm-tables'] }); // new tables show in the sidebar
      }
    };
    // EventSource reconnects by itself; refetch to catch anything missed meanwhile.
    es.onerror = () => { void qc.invalidateQueries({ queryKey: ['agent-session', sessionId] }); };
    return () => es.close();
  }, [sessionId, qc]);
}

function Conversation({ sessionId, historyOpen, toggleHistory }: { sessionId: number; historyOpen: boolean; toggleHistory: () => void }) {
  const qc = useQueryClient();
  const { toast } = useUi();
  const config = useAgentConfig();
  const q = useQuery({ queryKey: ['agent-session', sessionId], queryFn: () => api.get(`/api/agent/sessions/${sessionId}`).then((r) => r.data as AgentSession) });
  useSessionStream(sessionId);
  const s = q.data;
  const [model, setModel] = useState<string | null>(null);
  const chosenModel = model ?? s?.model ?? '';
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const messages = s?.messages ?? [];
  const running = s?.status === 'running';

  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages.length, messages.at(-1)?.status, running]);

  const refresh = () => qc.invalidateQueries({ queryKey: ['agent-session', sessionId] });
  const send = async (content: string) => {
    stick.current = true;
    try { await api.post(`/api/agent/sessions/${sessionId}/messages`, { content, model: chosenModel || null }); await refresh(); } catch (e) { toast(errorMessage(e), 'error'); }
  };
  const stop = async () => { try { await api.post(`/api/agent/sessions/${sessionId}/stop`); await refresh(); } catch (e) { toast(errorMessage(e), 'error'); } };
  const answer = async (messageId: number, body: { answer?: string; approve?: boolean }) => {
    stick.current = true;
    try { await api.post(`/api/agent/sessions/${sessionId}/answer`, { message_id: messageId, ...body }); await refresh(); } catch (e) { toast(errorMessage(e), 'error'); }
  };

  const items = useMemo(() => groupMessages(messages), [messages]);
  const lastTool = messages.at(-1);
  const thinking = running && !(lastTool?.role === 'tool' && lastTool.status === 'running');

  if (q.isError) return <div className="p-8 text-[13.5px] text-zinc-500">This chat could not be loaded. <Link to="/agent" className="text-brand-600">Start a new one</Link>.</div>;

  return (
    <>
      <TopBar title={s?.title ?? 'Loading…'} historyOpen={historyOpen} toggleHistory={toggleHistory}
        right={s && <span className="shrink-0 text-[11.5px] text-zinc-400" title={`${s.usage.prompt_tokens.toLocaleString()} prompt + ${s.usage.completion_tokens.toLocaleString()} completion tokens`}>
          {(s.usage.prompt_tokens + s.usage.completion_tokens).toLocaleString()} tokens{s.usage.cost_usd > 0 ? ` · $${s.usage.cost_usd.toFixed(s.usage.cost_usd < 0.1 ? 4 : 2)}` : ''}
        </span>} />
      <div ref={scroller} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }} className="min-h-0 flex-1 overflow-y-auto scroll-thin">
        <div className="mx-auto w-full max-w-[760px] px-4 py-6">
          {items.map((it) => it.kind === 'user'
            ? <div key={it.msg.id} className="mb-5 flex justify-end"><div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-zinc-100 px-3.5 py-2 text-[13.5px] text-zinc-900">{it.msg.content}</div></div>
            : <AssistantTurn key={it.key} messages={it.msgs} onAnswer={answer} />)}
          {thinking && <div className="flex items-center gap-2 py-1 text-[13px] text-zinc-400"><Loader2 className="size-3.5 animate-spin" /> Thinking…</div>}
          {s?.status === 'error' && s.error && !messages.at(-1)?.meta?.error && <div className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-[13px] text-red-700">{s.error}</div>}
        </div>
      </div>
      <div className="shrink-0 px-4 pb-4">
        <div className="mx-auto w-full max-w-[760px]">
          <Composer onSend={send} onStop={stop} running={running} model={chosenModel} setModel={setModel} config={config.data}
            placeholder={s?.status === 'waiting' ? 'Answer above, or type to move on…' : undefined} />
        </div>
      </div>
    </>
  );
}

type Item = { kind: 'user'; msg: AgentMessage } | { kind: 'agent'; key: string; msgs: AgentMessage[] };

/** User messages stand alone; everything the agent does until the next user message is one turn. */
function groupMessages(msgs: AgentMessage[]): Item[] {
  const out: Item[] = [];
  for (const m of msgs) {
    if (m.role === 'user') { out.push({ kind: 'user', msg: m }); continue; }
    const last = out.at(-1);
    if (last?.kind === 'agent') last.msgs.push(m);
    else out.push({ kind: 'agent', key: `a${m.id}`, msgs: [m] });
  }
  return out;
}

function AssistantTurn({ messages, onAnswer }: { messages: AgentMessage[]; onAnswer: (id: number, b: { answer?: string; approve?: boolean }) => Promise<void> }) {
  return (
    <div className="mb-5 flex flex-col gap-1">
      {messages.map((m) => {
        if (m.role === 'assistant') return m.content.trim()
          ? <div key={m.id} className={cx('py-0.5', m.meta?.error && 'text-red-700')}><Markdown text={m.content} /></div>
          : null;
        if (m.status === 'waiting' && m.meta.pause) return <PauseCard key={m.id} msg={m} onAnswer={onAnswer} />;
        return <ToolStep key={m.id} msg={m} />;
      })}
    </div>
  );
}

const TOOL_ICON: Record<string, typeof Wrench> = { load_skill: BookOpen, knowledge: BookOpen, web_search: Search, fetch_page: Globe, find_endpoints: Search, api: Table2, ask_user: Hand };

function ToolStep({ msg }: { msg: AgentMessage }) {
  const [open, setOpen] = useState(false);
  const Icon = TOOL_ICON[msg.tool_name ?? ''] ?? Wrench;
  const label = msg.meta.label ?? msg.tool_name ?? 'Tool';
  const pause = msg.meta.pause;
  return (
    <div className="group">
      <div className="flex min-h-7 items-center gap-2 text-[12.5px]">
        <button onClick={() => setOpen((o) => !o)} className="flex min-w-0 items-center gap-2 rounded-md py-0.5 pr-1.5 text-left text-zinc-500 hover:text-zinc-800">
          <StatusIcon status={msg.status} />
          <Icon className="size-3.5 shrink-0 text-zinc-400" strokeWidth={1.75} />
          <span className={cx('truncate', msg.status === 'failed' && 'text-red-600')}>{label}</span>
          {open ? <ChevronDown className="size-3 shrink-0 opacity-60" /> : <ChevronRight className="size-3 shrink-0 opacity-0 group-hover:opacity-60" />}
        </button>
        {msg.meta.links?.map((l) => (
          <Link key={l.to} to={l.to} className="inline-flex shrink-0 items-center gap-1 rounded-md bg-zinc-100 px-1.5 py-0.5 text-[11.5px] font-medium text-zinc-700 hover:bg-zinc-200">
            {l.label}<ExternalLink className="size-3" />
          </Link>
        ))}
        {msg.meta.decision && <span className={cx('text-[11.5px]', msg.meta.decision === 'approved' ? 'text-emerald-600' : 'text-zinc-400')}>{msg.meta.decision === 'approved' ? 'Approved by you' : 'Declined by you'}</span>}
        {pause?.type === 'question' && msg.meta.answer && <span className="truncate text-[11.5px] text-zinc-400">“{msg.meta.answer}”</span>}
      </div>
      {open && (
        <div className="mb-1 ml-[22px] mt-0.5 space-y-1.5 rounded-lg bg-zinc-50 p-2.5 ring-1 ring-zinc-200/70">
          {pause?.type === 'question' && <div className="text-[12.5px] text-zinc-700">{pause.question}</div>}
          {msg.tool_args && Object.keys(msg.tool_args).length > 0 && <Pre label="Input" text={JSON.stringify(msg.tool_args, null, 2)} />}
          {msg.content && <Pre label="Result" text={msg.content} />}
        </div>
      )}
    </div>
  );
}

function Pre({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <div className="mb-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-zinc-400">{label}</div>
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all font-mono text-[11.5px] leading-snug text-zinc-700 scroll-thin">{text.length > 8000 ? `${text.slice(0, 8000)}…` : text}</pre>
    </div>
  );
}

function StatusIcon({ status }: { status: AgentMessage['status'] }) {
  if (status === 'running') return <Loader2 className="size-3.5 shrink-0 animate-spin text-zinc-500" />;
  if (status === 'done') return <Check className="size-3.5 shrink-0 text-emerald-600" />;
  if (status === 'failed') return <X className="size-3.5 shrink-0 text-red-500" />;
  if (status === 'waiting') return <Clock className="size-3.5 shrink-0 text-amber-500" />;
  if (status === 'skipped') return <Minus className="size-3.5 shrink-0 text-zinc-400" />;
  return <Circle className="size-3.5 shrink-0 text-zinc-300" />;
}

function PauseCard({ msg, onAnswer }: { msg: AgentMessage; onAnswer: (id: number, b: { answer?: string; approve?: boolean }) => Promise<void> }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const pause = msg.meta.pause!;
  const go = async (b: { answer?: string; approve?: boolean }) => { setBusy(true); try { await onAnswer(msg.id, b); } finally { setBusy(false); } };

  if (pause.type === 'approval') {
    const r = pause.request;
    const body = r.body !== undefined ? JSON.stringify(r.body, null, 2) : '';
    return (
      <div className="my-1.5 rounded-xl border border-amber-200 bg-amber-50/60 p-3">
        <div className="flex items-start gap-2">
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-600" />
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium text-zinc-900">Approve this action?</div>
            <div className="text-[12.5px] text-zinc-600">{pause.reason}</div>
            <div className="mt-1.5 font-mono text-[12px] text-zinc-800">{r.method} {r.path}{r.query ? `?${new URLSearchParams(r.query as any).toString()}` : ''}</div>
            {body && body !== '{}' && <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-white/70 p-2 font-mono text-[11.5px] text-zinc-700 ring-1 ring-amber-100 scroll-thin">{body.length > 3000 ? `${body.slice(0, 3000)}…` : body}</pre>}
            <div className="mt-2.5 flex gap-2">
              <Button size="sm" variant="primary" loading={busy} onClick={() => go({ approve: true })}>Approve</Button>
              <Button size="sm" disabled={busy} onClick={() => go({ approve: false })}>Decline</Button>
            </div>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="my-1.5 rounded-xl border border-zinc-200 bg-white p-3 shadow-sm">
      <div className="flex items-start gap-2">
        <Hand className="mt-0.5 size-4 shrink-0 text-zinc-500" />
        <div className="min-w-0 flex-1">
          <div className="whitespace-pre-wrap text-[13.5px] text-zinc-900">{pause.question}</div>
          {pause.options.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {pause.options.map((o) => <Button key={o} size="sm" disabled={busy} onClick={() => go({ answer: o })}>{o}</Button>)}
            </div>
          )}
          <form className="mt-2 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (text.trim()) void go({ answer: text.trim() }); }}>
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder={pause.options.length ? 'Or type an answer…' : 'Type your answer…'}
              className="h-8 min-w-0 flex-1 rounded-lg border border-zinc-200 px-2.5 text-[13px] focus:border-zinc-300 focus:outline-none" />
            <Button size="sm" type="submit" variant="primary" disabled={!text.trim()} loading={busy}>Reply</Button>
          </form>
        </div>
      </div>
    </div>
  );
}
