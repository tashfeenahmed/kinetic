import { useNavigate, useParams, useSearchParams } from 'react-router';
import { BookOpen, MessageSquare, Sparkles } from 'lucide-react';
import { cx } from '../components/ui.tsx';
import { AgentChat } from './agent/Chat.tsx';
import { AgentSkills } from './agent/Skills.tsx';

/** Kinetic Agent: chat that builds tables, enriches, drafts campaigns — plus its skills. */
export function AgentPage() {
  const { sessionId } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const view = params.get('view') === 'skills' ? 'skills' : 'chat';
  const tab = (id: 'chat' | 'skills', label: string, Icon: typeof Sparkles) => (
    <button onClick={() => (id === 'chat' ? (view === 'chat' ? navigate('/agent') : setParams({})) : setParams({ view: 'skills' }))}
      className={cx('flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium', view === id ? 'bg-white text-zinc-900 shadow-sm ring-1 ring-zinc-200' : 'text-zinc-500 hover:text-zinc-900')}>
      <Icon className="size-3.5" />{label}
    </button>
  );
  return (
    <div className="flex h-full min-h-0 flex-col bg-white">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-zinc-200/80 px-4">
        <span className="flex items-center gap-2 text-[14px] font-semibold text-zinc-900"><Sparkles className="size-4" />Agent</span>
        <div className="flex gap-0.5 rounded-lg bg-zinc-100 p-0.5">
          {tab('chat', 'Chat', MessageSquare)}
          {tab('skills', 'Skills', BookOpen)}
        </div>
      </div>
      {view === 'skills' ? <AgentSkills /> : <AgentChat sessionId={sessionId ? Number(sessionId) : null} />}
    </div>
  );
}
