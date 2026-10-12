/**
 * Company list building with the research agent (web search + page reading).
 * Used when the free YC directory can't answer a query ("POS system companies"
 * includes Square, Toast, Lightspeed…). Needs an OpenRouter key or local model.
 */
import { runAgent } from '../engine/agent.ts';
import { toDomain } from '../lib/sandbox.ts';
import type { Ctx } from './types.ts';

export async function aiCompanySearch(query: string, ctx: Ctx, limit = 25): Promise<Record<string, unknown>[]> {
  const n = Math.min(limit, 40);
  const r = await runAgent({
    prompt: `Build a list of up to ${n} real companies that match this description: "${query}".
Search the web (lists, directories, review sites like G2/Capterra, news) and prefer established, currently operating companies.
For each company give its name, its primary website domain (no protocol), and a short description of what it does.`,
    outputs: [{ name: 'companies', type: 'list', description: `Up to ${n} items, each formatted exactly as "Company Name | domain.com | one-line description"` }],
    webSearch: true,
    fetchPages: true,
    maxSteps: 10,
  }, ctx);
  const items = (r.output.companies as unknown[] | null) ?? [];
  const seen = new Set<string>();
  const rows: Record<string, unknown>[] = [];
  for (const raw of items) {
    const [name, domain, ...desc] = String(raw).split('|').map((x) => x.trim());
    const d = toDomain(domain ?? '');
    if (!name || seen.has((d || name).toLowerCase())) continue;
    seen.add((d || name).toLowerCase());
    rows.push({ Company: name, 'Company domain': d, Description: desc.join(' | '), Source: 'AI web search' });
  }
  return rows.slice(0, n);
}
