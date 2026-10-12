export interface AgentLink { label: string; to: string }

export interface AgentMessage {
  id: number;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  status: 'running' | 'done' | 'failed' | 'waiting' | 'skipped';
  tool_name: string | null;
  tool_args: Record<string, unknown> | null;
  meta: {
    label?: string;
    links?: AgentLink[];
    error?: boolean;
    decision?: 'approved' | 'declined';
    answer?: string;
    pause?:
      | { type: 'question'; question: string; options: string[] }
      | { type: 'approval'; reason: string; request: { method: string; path: string; query?: Record<string, unknown>; body?: unknown } };
  };
  created_at: string;
}

export interface AgentSession {
  id: number;
  title: string;
  model: string | null;
  status: 'idle' | 'running' | 'waiting' | 'error';
  error: string | null;
  usage: { prompt_tokens: number; completion_tokens: number; cost_usd: number };
  created_at: string;
  updated_at: string;
  running?: boolean;
  messages?: AgentMessage[];
}

export interface AgentSkill { id?: number; name: string; description: string; body: string; builtin: boolean; updated_at?: string }

export interface AgentConfig { models: { id: string; label: string; free: boolean }[]; defaultModel: string; aiReady: boolean }
