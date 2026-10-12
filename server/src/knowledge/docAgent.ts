/**
 * "@Agent" inside a Knowledge Hub document: a short tool-using loop that sees the
 * whole document, where the cursor is (or what is selected), the doc's title and
 * folder and the rest of the Knowledge Hub, can search the web and read pages, and
 * returns markdown to put in the document plus how to place it (insert at the
 * cursor, replace the selection, append a section, or rewrite the whole doc).
 */
import type { Ctx } from '../context.ts';
import { webSearch } from '../gtm/providers/search.ts';
import { readPage } from '../gtm/engine/agent.ts';
import { agentModel, aiReady, chat, fnTool, type ToolCall } from '../agent/llm.ts';
import { docsInTreeOrder, findDoc, knowledgeContext, pathTitle, type KnowledgeDoc } from './store.ts';
import { cleanMarkdown } from './research.ts';

export const EDIT_MODES = ['insert', 'replace', 'append', 'rewrite'] as const;
export type EditMode = (typeof EDIT_MODES)[number];

export interface DocAgentInput {
  instruction: string;
  /** Selected text (markdown or plain) — "replace" swaps it for the result. */
  selection?: string;
  /** Markdown before and after the cursor, so the agent knows where it is writing. */
  before?: string;
  after?: string;
  /** Forced placement; 'auto' (default) lets the agent choose. */
  mode?: EditMode | 'auto';
}

export interface DocAgentResult {
  markdown: string;
  mode: EditMode;
  note: string;
  steps: string[];
  usage: { prompt: number; completion: number; costUsd: number };
}

const MAX_STEPS = 6;

const TOOLS = [
  fnTool('web_search', 'Search the web. Returns titles, URLs and snippets.', { query: { type: 'string' } }, ['query']),
  fnTool('fetch_page', 'Fetch a web page and return its readable text.', { url: { type: 'string' } }, ['url']),
  fnTool('read_doc', 'Read another Knowledge Hub document in full, by title or id.', { doc: { type: 'string' } }, ['doc']),
  fnTool('write', 'Finish: the markdown to put in the document and where it goes.', {
    markdown: { type: 'string', description: 'GitHub-flavoured markdown to insert. No "#" title. Tables as GFM tables.' },
    mode: { type: 'string', enum: [...EDIT_MODES], description: 'insert = at the cursor; replace = replaces the selected text; append = a new section at the end; rewrite = replaces the whole document' },
    note: { type: 'string', description: 'One short sentence for the user about what you wrote' },
  }, ['markdown', 'mode']),
];

/** Mode from the instruction when the user didn't pick one (the model may still refine it). */
export function inferMode(instruction: string, hasSelection: boolean): EditMode | null {
  const s = instruction.toLowerCase();
  if (/\b(rewrite|redo|restructure)\b.*\b(whole|entire|full|all of)\b.*\b(doc|document|page)\b|\brewrite (the|this) (doc|document|page)\b/.test(s)) return 'rewrite';
  if (hasSelection && /\b(rewrite|rephrase|shorten|expand|improve|fix|translate|replace|turn (this|it) into|make (this|it))\b/.test(s)) return 'replace';
  if (/\b(add|append) (a |an )?(new )?section\b|\bat the end\b/.test(s)) return 'append';
  return null;
}

export async function runDocAgent(ctx: Ctx, workspaceId: number, doc: KnowledgeDoc & { path?: string }, input: DocAgentInput, onStep?: (label: string) => void): Promise<DocAgentResult> {
  const settings = ctx.gtm!.settings;
  if (!aiReady(settings)) throw Object.assign(new Error('Set OPENROUTER_API_KEY on the Integrations page (or AI_BASE_URL for a local model) to use the agent in documents'), { statusCode: 400 });
  const model = agentModel(settings);
  const selection = input.selection?.trim() ?? '';
  const forced = input.mode && input.mode !== 'auto' ? input.mode : inferMode(input.instruction, !!selection);
  const steps: string[] = [];
  const usage = { prompt: 0, completion: 0, costUsd: 0 };
  const step = (label: string) => { steps.push(label); onStep?.(label); };

  const kb = knowledgeContext(ctx, workspaceId, 4000);
  const others = docsInTreeOrder(ctx.db, workspaceId).filter((d) => d.id !== doc.id).map((d) => `#${d.id} ${pathTitle(d)}`).slice(0, 60).join('\n');
  const where = selection
    ? `The user selected this text (it is what "this" refers to):\n<<<SELECTION\n${selection.slice(0, 8000)}\nSELECTION>>>`
    : input.before != null || input.after != null
      ? `The cursor is between these two parts of the document:\n<<<BEFORE CURSOR (end)\n${(input.before ?? '').slice(-3000)}\n>>>\n<<<AFTER CURSOR (start)\n${(input.after ?? '').slice(0, 1500)}\n>>>`
      : 'No cursor position was given: new text goes at the end unless the instruction says otherwise.';
  const messages: any[] = [
    {
      role: 'system',
      content: `You are the Kinetic Agent writing inside a Knowledge Hub document (a go-to-market knowledge base for sales and outbound). Today is ${new Date().toISOString().slice(0, 10)}.
- Follow the user's instruction. Use the document, the Knowledge Hub and, when the instruction needs facts you don't have (pricing, competitors, examples, news), research with web_search and fetch_page (a few calls at most).
- Finish by calling write once with markdown in the document's style: "##"/"###" headings (never a "#" title), bullets, **bold** labels, GFM tables (| a | b | with a | --- | row) when asked for a table or comparing things. When filling an existing table, return the whole table.
- Write only the new or replacement text: never repeat the rest of the document unless mode is rewrite.
- Be factual; mark guesses "(inferred)"; link sources you used.
- mode: ${forced ? `use "${forced}" (the user chose it)` : `"insert" at the cursor by default; "replace" when the user selected text and asks to change it; "append" for a new section at the end; "rewrite" only when asked to rewrite the whole document`}.

Document: "${doc.title}"${doc.path ? ` in folder "${doc.path}"` : ''} (doc #${doc.id})
<<<DOCUMENT
${doc.content.slice(0, 30_000) || '(empty)'}
DOCUMENT>>>

${where}

Other Knowledge Hub documents (read with read_doc):
${others || '(none)'}

Knowledge Hub summary:
${kb || '(empty)'}`,
    },
    { role: 'user', content: input.instruction },
  ];

  for (let i = 0; i < MAX_STEPS; i++) {
    const last = i === MAX_STEPS - 1;
    step(i === 0 ? 'Thinking…' : last ? 'Writing…' : 'Thinking…');
    const r = await chat(settings, {
      model, messages, tools: TOOLS, max_tokens: 4000,
      ...(last ? { tool_choice: { type: 'function', function: { name: 'write' } } } : {}),
    });
    usage.prompt += r.usage.prompt; usage.completion += r.usage.completion; usage.costUsd += r.usage.costUsd;
    const calls: ToolCall[] = (r.message.tool_calls ?? []).map((c, j) => ({ ...c, id: c.id || `call_${i}_${j}`, type: 'function' as const }));
    if (!calls.length) {
      // Plain prose answer: treat it as the text to write.
      const markdown = cleanMarkdown(r.message.content);
      if (!markdown) throw new Error('The agent returned nothing to write.');
      return { markdown, mode: resolveMode(forced, null, !!selection), note: '', steps, usage };
    }
    messages.push({ role: 'assistant', content: r.message.content ?? '', tool_calls: calls });
    for (const c of calls) {
      let args: any = {};
      try { args = JSON.parse(c.function.arguments || '{}'); } catch { /* bad json */ }
      if (c.function.name === 'write') {
        const markdown = cleanMarkdown(String(args.markdown ?? ''));
        if (!markdown) { messages.push({ role: 'tool', tool_call_id: c.id, content: 'Error: markdown was empty.' }); continue; }
        step('Writing…');
        return { markdown, mode: resolveMode(forced, args.mode, !!selection), note: String(args.note ?? ''), steps, usage };
      }
      messages.push({ role: 'tool', tool_call_id: c.id, content: await tool(ctx, workspaceId, c.function.name, args, step) });
    }
  }
  throw new Error('The agent did not finish writing.');
}

function resolveMode(forced: EditMode | null, chosen: unknown, hasSelection: boolean): EditMode {
  let m: EditMode = forced ?? ((EDIT_MODES as readonly string[]).includes(String(chosen)) ? (chosen as EditMode) : hasSelection ? 'replace' : 'insert');
  if (m === 'replace' && !hasSelection) m = 'insert';
  return m;
}

async function tool(ctx: Ctx, workspaceId: number, name: string, args: any, step: (l: string) => void): Promise<string> {
  const settings = ctx.gtm!.settings;
  try {
    switch (name) {
      case 'web_search': {
        step(`Searching the web for “${String(args.query ?? '').slice(0, 80)}”…`);
        const r = await webSearch(String(args.query ?? ''), { settings, log: () => {} }, 8);
        return r.results.map((x, i) => `${i + 1}. ${x.title}\n${x.url}\n${x.snippet}`).join('\n\n') || 'No results.';
      }
      case 'fetch_page': {
        const url = String(args.url ?? '');
        step(`Reading ${url.replace(/^https?:\/\//, '').slice(0, 60)}…`);
        return (await readPage(url, { settings, log: () => {} })).slice(0, 10_000);
      }
      case 'read_doc': {
        const d = findDoc(ctx.db, workspaceId, String(args.doc ?? ''));
        step(d ? `Reading “${d.title}”…` : 'Looking for a document…');
        return d ? `# ${d.title}\n\n${d.content.slice(0, 15_000)}` : `No document matching "${args.doc}".`;
      }
      default: return `Unknown tool ${name}.`;
    }
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}

/**
 * Applies an agent edit to stored markdown (the API path; the editor applies it
 * itself so it is one undo step). `cursor` is a character offset in the markdown.
 */
export function applyEdit(content: string, e: { markdown: string; mode: EditMode; selection?: string; cursor?: number }): string {
  const md = e.markdown.trim();
  const join = (a: string, b: string) => [a.trimEnd(), b.trimStart()].filter(Boolean).join('\n\n');
  switch (e.mode) {
    case 'rewrite': return md;
    case 'append': return join(content, md);
    case 'replace': {
      const sel = e.selection?.trim();
      if (!sel || !content.includes(sel)) throw Object.assign(new Error('The selected text was not found in the document (it may have changed). Nothing was replaced.'), { statusCode: 409 });
      return content.replace(sel, md);
    }
    case 'insert': {
      if (e.cursor == null || e.cursor >= content.length) return join(content, md);
      // Insert at the nearest line break at or after the cursor, as its own block.
      const at = Math.max(0, e.cursor);
      const nl = content.indexOf('\n', at);
      const cut = at === 0 ? 0 : nl === -1 ? content.length : nl;
      return join(join(content.slice(0, cut), md), content.slice(cut));
    }
  }
}
