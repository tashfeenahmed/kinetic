/**
 * AI research column: an OpenRouter tool-calling loop (web_search, fetch_page)
 * that ends by calling `submit` with the column's output fields.
 */
import { getJson } from '../lib/http.ts';
import { fetchPage } from '../lib/html.ts';
import { webSearch } from '../providers/search.ts';
import type { Ctx } from '../providers/types.ts';

export const DEFAULT_MODEL = 'anthropic/claude-haiku-5.5';
export const MODELS = [
  { id: 'anthropic/claude-haiku-5.5', label: 'Claude Haiku 5.5 ($0.10 / $0.50 per M)' },
  { id: 'google/gemini-3.8-flash', label: 'Gemini 3.8 Flash ($0.75 / $3.75 per M)' },
  { id: 'google/gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash Lite ($0.30 / $2.50 per M)' },
  { id: 'anthropic/claude-sonnet-5.5', label: 'Claude Sonnet 5.5' },
  { id: 'openrouter/free', label: 'OpenRouter free router — FREE (20/min; 50/day, 1,000/day after $10 credit)' },
];

let modelCache: { at: number; list: { id: string; label: string; free: boolean }[] } | null = null;

/** Tool-capable OpenRouter models (free ones first), cached for an hour; falls back to MODELS. */
export async function listModels(): Promise<{ id: string; label: string; free: boolean }[]> {
  if (modelCache && Date.now() - modelCache.at < 3_600_000) return modelCache.list;
  try {
    const d = await getJson('https://openrouter.ai/api/v1/models', { timeoutMs: 8000 });
    const perM = (x: string) => `$${(Number(x) * 1e6).toFixed(2).replace(/\.00$/, '')}`;
    const list = (d.data ?? [])
      .filter((m: any) => (m.supported_parameters ?? []).includes('tools') && !String(m.id).endsWith(':batch'))
      .map((m: any) => {
        const free = String(m.id).endsWith(':free') || (Number(m.pricing?.prompt) === 0 && Number(m.pricing?.completion) === 0);
        return { id: m.id, free, label: free ? `${m.name ?? m.id} — FREE` : `${m.name ?? m.id} (${perM(m.pricing?.prompt)} / ${perM(m.pricing?.completion)} per M)` };
      });
    const pinned = MODELS.map((p) => list.find((m: any) => m.id === p.id) ?? { ...p, free: p.id.includes('free') });
    const rest = list.filter((m: any) => !MODELS.some((p) => p.id === m.id)).sort((a: any, b: any) => Number(b.free) - Number(a.free) || a.id.localeCompare(b.id));
    modelCache = { at: Date.now(), list: [...pinned, ...rest] };
    return modelCache.list;
  } catch {
    return MODELS.map((m) => ({ ...m, free: m.id.includes('free') }));
  }
}

export interface OutputField { name: string; type: 'string' | 'number' | 'boolean' | 'list' | 'url'; description?: string }

export interface AgentConfig {
  prompt: string; // already rendered with row values
  model?: string;
  outputs: OutputField[];
  webSearch: boolean;
  fetchPages: boolean;
  maxSteps?: number;
}

export interface AgentResult {
  output: Record<string, unknown>;
  sources: string[];
  steps: { tool: string; input: string; ok: boolean }[];
  usage: { prompt: number; completion: number; costUsd?: number };
  model: string;
}

const SYSTEM = `You are a meticulous B2B research analyst working on one row of a prospecting spreadsheet.
Use the tools to find facts; do not invent them. Prefer primary sources (the company's own site, filings, reputable press).
Be efficient: a few targeted searches, then read the most promising pages.
When you are done, call the submit tool exactly once with every requested field. Use null when a fact cannot be found.
Keep string answers concise (one or two sentences unless asked otherwise).`;

export async function runAgent(cfg: AgentConfig, ctx: Ctx): Promise<AgentResult> {
  // Any OpenAI-compatible endpoint works: OpenRouter (default), or a local Ollama /
  // LM Studio server via AI_BASE_URL (e.g. http://localhost:11434/v1) for free inference.
  const base = (ctx.settings.get('AI_BASE_URL') || 'https://openrouter.ai/api/v1').replace(/\/$/, '');
  const local = !base.includes('openrouter.ai');
  const key = ctx.settings.get('OPENROUTER_API_KEY');
  if (!key && !local) throw new Error('Set OPENROUTER_API_KEY in Settings, or AI_BASE_URL for a local model');
  const model = cfg.model || ctx.settings.get('AI_MODEL') || DEFAULT_MODEL;
  const outputs = cfg.outputs.length ? cfg.outputs : [{ name: 'answer', type: 'string' as const }];
  const maxSteps = Math.min(cfg.maxSteps ?? 8, 20);

  const tools: any[] = [submitTool(outputs)];
  if (cfg.webSearch) tools.push(fn('web_search', 'Search the web. Returns titles, URLs and snippets.', { query: { type: 'string' } }, ['query']));
  if (cfg.fetchPages) tools.push(fn('fetch_page', 'Fetch a web page and return its readable text (first ~12k chars).', { url: { type: 'string' } }, ['url']));

  const messages: any[] = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `${cfg.prompt}\n\nReturn these fields via submit: ${outputs.map((o) => `${o.name} (${o.type}${o.description ? `: ${o.description}` : ''})`).join('; ')}` },
  ];
  const result: AgentResult = { output: {}, sources: [], steps: [], usage: { prompt: 0, completion: 0, costUsd: 0 }, model };

  for (let step = 0; step < maxSteps; step++) {
    const last = step === maxSteps - 1;
    const d = await getJson(`${base}/chat/completions`, {
      headers: local ? {} : { authorization: `Bearer ${key}`, 'HTTP-Referer': 'http://localhost/kineticsand', 'X-Title': 'kineticsand' },
      json: {
        model, messages, tools, temperature: 0.2, max_tokens: 2000,
        tool_choice: last ? { type: 'function', function: { name: 'submit' } } : 'auto',
        ...(local ? {} : { usage: { include: true } }),
      },
      timeoutMs: 120_000,
    });
    result.usage.prompt += d.usage?.prompt_tokens ?? 0;
    result.usage.completion += d.usage?.completion_tokens ?? 0;
    result.usage.costUsd = (result.usage.costUsd ?? 0) + (d.usage?.cost ?? 0);
    const msg = d.choices?.[0]?.message;
    if (!msg) throw new Error(`OpenRouter returned no message: ${JSON.stringify(d).slice(0, 300)}`);
    messages.push({ role: 'assistant', content: msg.content ?? '', tool_calls: msg.tool_calls });

    const calls: any[] = msg.tool_calls ?? [];
    if (!calls.length) {
      // Model answered in prose; ask it to use submit.
      if (outputs.length === 1 && outputs[0].type === 'string' && msg.content && last) { result.output = { [outputs[0].name]: msg.content }; return result; }
      messages.push({ role: 'user', content: 'Call the submit tool with the fields now.' });
      continue;
    }
    for (const call of calls) {
      const name = call.function?.name;
      let args: any = {};
      try { args = JSON.parse(call.function?.arguments || '{}'); } catch { /* bad args */ }
      if (name === 'submit') {
        result.output = coerce(args, outputs);
        if (Array.isArray(args.sources)) result.sources.push(...args.sources.filter((x: unknown) => typeof x === 'string'));
        result.sources = [...new Set(result.sources)].slice(0, 20);
        return result;
      }
      let content: string;
      try {
        if (name === 'web_search') {
          const r = await webSearch(String(args.query ?? ''), ctx, 8);
          content = r.results.map((x, i) => `${i + 1}. ${x.title}\n${x.url}\n${x.snippet}`).join('\n\n') || 'No results.';
          result.steps.push({ tool: 'web_search', input: args.query, ok: true });
        } else if (name === 'fetch_page') {
          content = await readPage(String(args.url ?? ''), ctx);
          result.sources.push(String(args.url));
          result.steps.push({ tool: 'fetch_page', input: args.url, ok: true });
        } else {
          content = `Unknown tool ${name}`;
        }
      } catch (e: any) {
        content = `Error: ${e.message}`;
        result.steps.push({ tool: name, input: JSON.stringify(args), ok: false });
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: content.slice(0, 14_000) });
    }
  }
  throw new Error('Agent did not submit an answer');
}

async function readPage(url: string, ctx: Ctx): Promise<string> {
  // Jina Reader renders JS-heavy pages; plain fetch is the free default.
  if (ctx.settings.has('JINA_API_KEY')) {
    const res = await fetch(`https://r.jina.ai/${url}`, { headers: { authorization: `Bearer ${ctx.settings.get('JINA_API_KEY')}` }, signal: AbortSignal.timeout(40_000) });
    if (res.ok) return (await res.text()).slice(0, 12_000);
  }
  const page = await fetchPage(url);
  return `Title: ${page.title}\nURL: ${page.url}\n\n${page.text.slice(0, 12_000)}`;
}

function fn(name: string, description: string, properties: Record<string, unknown>, required: string[]) {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } };
}

function submitTool(outputs: OutputField[]) {
  const properties: Record<string, unknown> = {};
  for (const o of outputs) {
    const t = o.type === 'list' ? { type: 'array', items: { type: 'string' } } : o.type === 'url' ? { type: 'string' } : { type: o.type };
    properties[o.name] = { ...t, description: o.description, nullable: true };
  }
  properties.sources = { type: 'array', items: { type: 'string' }, description: 'URLs that support the answer' };
  return fn('submit', 'Submit the final answer for this row.', properties, outputs.map((o) => o.name));
}

function coerce(args: Record<string, unknown>, outputs: OutputField[]) {
  const out: Record<string, unknown> = {};
  for (const o of outputs) {
    let v = args[o.name];
    if (v === undefined || v === 'null' || v === 'N/A') v = null;
    if (v != null && o.type === 'number') { const n = Number(String(v).replace(/[^0-9.-]/g, '')); v = Number.isFinite(n) ? n : null; }
    if (v != null && o.type === 'boolean') v = v === true || /^(true|yes|1)$/i.test(String(v));
    if (v != null && o.type === 'list' && !Array.isArray(v)) v = String(v).split(/,\s*/);
    out[o.name] = v;
  }
  return out;
}
