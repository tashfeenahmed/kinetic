/** "Find lookalike companies" enrichment: one waterfall step that runs the lookalike search for a row's domain. */
import type { ProviderStep } from '../gtm/providers/types.ts';
import { companyLookalikes } from './lookalikes.ts';

export const lookalikeStep: ProviderStep = {
  id: 'lookalikes',
  label: 'Lookalikes (Apollo/PDL when keyed, else YC + Wikidata + AI web search)',
  requires: [],
  cost: 'free / provider credits when keyed',
  run: async (input, ctx) => {
    if (!input.domain) return null;
    const r = await companyLookalikes([input.domain], ctx, { limit: 10, tech: false });
    if (!r.rows.length) return null;
    return {
      value: r.rows.map((x) => x['Company domain'] || x.Company),
      data: { companies: r.rows.map((x) => ({ name: x.Company, domain: x['Company domain'], similarity: x.Similarity, reason: x['Similarity reason'], source: x.Source })), profile: { keywords: r.profile.keywords.map((k) => k.term), industries: r.profile.industries, summary: r.profile.summary }, sources: r.sources },
    };
  },
};
