/**
 * OpenRouter (or any OpenAI-compatible server via AI_BASE_URL) chat completions with
 * tool calling — the same endpoint, headers and usage accounting as the research
 * column agent in gtm/engine/agent.ts.
 */
import { getJson } from '../gtm/lib/http.ts';
import { DEFAULT_MODEL } from '../gtm/engine/agent.ts';
import type { Settings } from '../gtm/settings.ts';

export interface ChatUsage { prompt: number; completion: number; costUsd: number }
export interface ChatResult { message: { role: 'assistant'; content: string; tool_calls?: ToolCall[] }; usage: ChatUsage }
export interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }

export function aiReady(settings: Settings): boolean {
  return settings.has('OPENROUTER_API_KEY') || settings.has('AI_BASE_URL');
}

/** Agent chats default to AGENT_MODEL, then the table-wide AI_MODEL. */
export function agentModel(settings: Settings, chosen?: string | null): string {
  return chosen || settings.get('AGENT_MODEL') || settings.get('AI_MODEL') || DEFAULT_MODEL;
}

export async function chat(settings: Settings, body: { model: string; messages: unknown[]; tools?: unknown[]; tool_choice?: unknown; max_tokens?: number; temperature?: number }): Promise<ChatResult> {
  const base = (settings.get('AI_BASE_URL') || 'https://openrouter.ai/api/v1').replace(/\/$/, '');
  const local = !base.includes('openrouter.ai');
  const key = settings.get('OPENROUTER_API_KEY');
  if (!key && !local) throw new Error('Set OPENROUTER_API_KEY on the Integrations page, or AI_BASE_URL for a local model');
  const d = await getJson(`${base}/chat/completions`, {
    headers: local ? {} : { authorization: `Bearer ${key}`, 'HTTP-Referer': 'http://localhost/kineticsand', 'X-Title': 'kineticsand' },
    json: { temperature: 0.2, max_tokens: 4000, ...body, ...(local ? {} : { usage: { include: true } }) },
    timeoutMs: 180_000,
  });
  const msg = d.choices?.[0]?.message;
  if (!msg) throw new Error(`The model returned no message: ${JSON.stringify(d).slice(0, 300)}`);
  return {
    message: { role: 'assistant', content: msg.content ?? '', ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}) },
    usage: { prompt: d.usage?.prompt_tokens ?? 0, completion: d.usage?.completion_tokens ?? 0, costUsd: d.usage?.cost ?? 0 },
  };
}

export function fnTool(name: string, description: string, properties: Record<string, unknown>, required: string[] = []) {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } };
}
