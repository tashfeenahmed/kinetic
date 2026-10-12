/**
 * Personalised LinkedIn notes, messages and comments: {variables}, {spin|tax} and an
 * AI-written {ai_message} (like PhantomBuster's AI LinkedIn Message Writer) via the
 * configured OpenRouter/local model.
 */
import { render, hashSeed, varKey } from '../lib/template.ts';
import { runAgent } from '../gtm/engine/agent.ts';
import type { Settings } from '../gtm/settings.ts';
import { unwrap } from '../gtm/lib/template.ts';

export const AI_TOKEN = /\{\s*ai_message\s*\}/i;

export const aiReady = (settings: Settings) => settings.has('OPENROUTER_API_KEY') || settings.has('AI_BASE_URL');

const str = (v: unknown) => {
  const x = unwrap(v);
  return x == null ? '' : typeof x === 'object' ? JSON.stringify(x) : String(x).trim();
};

/** Variables available to templates: profile fields plus every column of the source row. */
export function profileVars(profile: Record<string, unknown> = {}, row: Record<string, unknown> = {}): Map<string, string> {
  const vars = new Map<string, string>();
  for (const [k, v] of Object.entries(row)) if (str(v)) vars.set(varKey(k), str(v));
  const full = str(profile.fullName ?? profile.full_name) || [str(profile.firstName ?? profile.first_name), str(profile.lastName ?? profile.last_name)].filter(Boolean).join(' ');
  const parts = full.split(/\s+/).filter(Boolean);
  const set = (k: string, v: string) => { if (v) vars.set(k, v); else if (!vars.has(k)) vars.set(k, ''); };
  set('FIRST_NAME', str(profile.firstName ?? profile.first_name) || parts[0] || '');
  set('LAST_NAME', str(profile.lastName ?? profile.last_name) || (parts.length > 1 ? parts[parts.length - 1]! : ''));
  set('FULL_NAME', full);
  set('COMPANY', str(profile.company));
  set('TITLE', str(profile.title));
  set('LOCATION', str(profile.location));
  set('HEADLINE', str(profile.headline));
  set('INDUSTRY', str(profile.industry));
  return vars;
}

export interface RenderOpts {
  template: string;
  profile?: Record<string, unknown>;
  row?: Record<string, unknown>;
  aiInstructions?: string;
  maxLength?: number;
  settings: Settings;
  /** Preview mode: no AI call; {ai_message} becomes a placeholder. */
  preview?: boolean;
  /** Swappable for tests. */
  ai?: (prompt: string) => Promise<string>;
}

export interface Rendered { text: string; missing: string[]; aiUsed: boolean }

export async function renderMessage(o: RenderOpts): Promise<Rendered> {
  const vars = profileVars(o.profile, o.row);
  let aiUsed = false;
  if (AI_TOKEN.test(o.template)) {
    if (o.preview) vars.set('AI_MESSAGE', '[AI-written line]');
    else {
      vars.set('AI_MESSAGE', await aiMessage(o));
      aiUsed = true;
    }
  }
  const missing = new Set<string>();
  const seed = hashSeed(str(o.profile?.profileUrl ?? o.profile?.fullName ?? ''), o.template);
  let text = render(o.template, vars, { seed, onUnknown: (name) => { missing.add(name); return ''; } });
  // Blank variables leave double spaces and orphaned punctuation behind.
  text = text.replace(/[ \t]{2,}/g, ' ').replace(/ +([,.!?])/g, '$1').replace(/^[ ,]+/gm, '').trim();
  // Variables with no value and no {name|fallback}.
  for (const m of o.template.matchAll(/\{([A-Za-z][A-Za-z0-9_ ]*)\}/g)) {
    const key = varKey(m[1]!);
    if (key !== 'AI_MESSAGE' && vars.has(key) && !vars.get(key)) missing.add(m[1]!.trim());
  }
  if (o.maxLength && text.length > o.maxLength) text = truncate(text, o.maxLength);
  return { text, missing: [...missing], aiUsed };
}

function truncate(text: string, max: number): string {
  const cut = text.slice(0, max);
  const at = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  if (at > max * 0.6) return cut.slice(0, at + 1);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[,;:\s]+$/, '');
}

async function aiMessage(o: RenderOpts): Promise<string> {
  const p = o.profile ?? {};
  const facts = Object.entries({ ...o.row, ...p })
    .filter(([, v]) => str(v))
    .map(([k, v]) => `${k}: ${str(v).slice(0, 600)}`)
    .slice(0, 30)
    .join('\n');
  const prompt = `Write ONE short, natural, personalised line for a LinkedIn message to this person. It is inserted into a template, so no greeting, no sign-off, no quotes, no hashtags, no emojis.
Instructions from the sender: ${o.aiInstructions?.trim() || 'Reference something specific about their role, company or recent activity. Friendly and genuine, no sales pitch. Max 200 characters.'}

What we know about them:
${facts || '(only the name)'}`;
  if (o.ai) return (await o.ai(prompt)).trim();
  if (!aiReady(o.settings)) throw new Error('{ai_message} needs an AI model: set OPENROUTER_API_KEY (or AI_BASE_URL for a local model) on the Integrations page');
  const r = await runAgent({ prompt, outputs: [{ name: 'message', type: 'string', description: 'the single line' }], webSearch: false, fetchPages: false, maxSteps: 2 },
    { settings: o.settings, log: () => {} });
  const msg = str(r.output.message).replace(/^["']|["']$/g, '');
  if (!msg) throw new Error('The AI model returned an empty message');
  return msg;
}

/** AI-drafted comment for the AI Post Responder (always reviewed by a person before posting). */
export async function draftComment(settings: Settings, post: { text?: string; authorName?: string }, instructions: string, ai?: (prompt: string) => Promise<string>): Promise<string> {
  const prompt = `Draft a LinkedIn comment on this post by ${post.authorName || 'someone'}.
Instructions: ${instructions || 'Add a thoughtful, specific point that builds on the post. 1-2 sentences, no emojis, no pitch.'}
Return only the comment text.

Post:
${(post.text ?? '').slice(0, 3000)}`;
  if (ai) return (await ai(prompt)).trim();
  if (!aiReady(settings)) throw new Error('AI not configured — set OPENROUTER_API_KEY on the Integrations page, or write the comment yourself');
  const r = await runAgent({ prompt, outputs: [{ name: 'comment', type: 'string' }], webSearch: false, fetchPages: false, maxSteps: 2 }, { settings, log: () => {} });
  return str(r.output.comment);
}
