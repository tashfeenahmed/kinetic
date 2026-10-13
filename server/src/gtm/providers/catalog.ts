/**
 * Enrichment kinds and their default waterfall order (cheapest/most accurate first,
 * free fallbacks last). A column can reorder or drop steps.
 */
import { webSearchEmailFinder } from './webEmail.ts';
import * as free from './free.ts';
import { freeEmailFinder } from './freeEmail.ts';
import * as open from './openData.ts';
import { smtpVerifyStep } from './freeVerify.ts';
import * as v from './vendors.ts';
import { lookalikeStep } from '../../sourcing/lookalikeStep.ts';
import { aiReadContacts, apolloContacts, hunterContacts, pdlContacts, prospeoContacts } from './people.ts';
import type { EnrichKind, ProviderStep } from './types.ts';

const step = (s: ProviderStep) => s;

export const ENRICH_KINDS: EnrichKind[] = [
  {
    id: 'work_email',
    label: 'Find work email',
    description: 'Free first (company website + GitHub patterns with an SMTP check, then emails published on the web); paid vendors only when those find nothing — Apollo, Hunter, Prospeo, People Data Labs. Stops at the first hit.',
    inputs: ['firstName', 'lastName', 'fullName', 'domain', 'companyName', 'linkedinUrl'],
    needs: [['fullName', 'domain'], ['firstName', 'domain'], ['fullName', 'companyName'], ['linkedinUrl']],
    steps: [
      step({ id: 'free_finder', label: 'Free finder (website + GitHub patterns, SMTP check)', requires: [], cost: 'free', run: freeEmailFinder }),
      step({ id: 'web_search', label: 'Web search (emails on public pages)', requires: [], cost: 'free with SearXNG', run: webSearchEmailFinder }),
      // Paid fallback, in this order; each stops once its monthly credit budget is used up.
      step({ id: 'apollo', label: 'Apollo', requires: ['APOLLO_API_KEY'], cost: '1 credit', run: v.apolloEmail }),
      step({ id: 'hunter', label: 'Hunter', requires: ['HUNTER_API_KEY'], cost: '1 credit', run: v.hunterEmail }),
      step({ id: 'prospeo', label: 'Prospeo', requires: ['PROSPEO_API_KEY'], cost: '1 credit', run: v.prospeoEmail }),
      step({ id: 'pdl', label: 'People Data Labs', requires: ['PDL_API_KEY'], cost: '1 person credit', run: v.pdlEmail }),
      step({ id: 'pattern_verified', label: 'Pattern + MillionVerifier', requires: ['MILLIONVERIFIER_API_KEY'], cost: '~$0.0012', run: (i, c) => v.patternVerified(i, c, free.patternGuess) }),
      step({ id: 'icypeas', label: 'Icypeas', requires: ['ICYPEAS_API_KEY'], cost: '~$0.01 when found', run: v.icypeasEmail }),
      step({ id: 'findymail', label: 'Findymail', requires: ['FINDYMAIL_API_KEY'], cost: '1 credit (verified only)', run: v.findymailEmail }),
      step({ id: 'leadmagic', label: 'LeadMagic', requires: ['LEADMAGIC_API_KEY'], cost: '1 credit', run: v.leadmagicEmail }),
      step({ id: 'pattern', label: 'Pattern guess (free, unverified)', requires: [], cost: 'free', run: (i) => free.patternGuess(i) }),
    ],
  },
  {
    id: 'decision_makers',
    label: 'Find decision makers + emails',
    description: 'Who to email at a company, with their email. First reads the company website (team, about, leadership, contact pages) and web search results with AI and finds each person\'s email for free (published, or pattern + SMTP check). Only if that finds nobody: Apollo, Hunter, Prospeo, People Data Labs. Title = roles to look for, e.g. "CEO, founder" (optional).',
    inputs: ['domain', 'companyName', 'title'],
    needs: [['domain']],
    steps: [
      step({ id: 'ai_read', label: 'Read website + web with AI (free)', requires: [], cost: 'free (AI tokens)', run: aiReadContacts }),
      step({ id: 'apollo', label: 'Apollo (search free, email 1 credit)', requires: ['APOLLO_API_KEY'], cost: '1 credit', run: apolloContacts }),
      step({ id: 'hunter', label: 'Hunter domain search', requires: ['HUNTER_API_KEY'], cost: '1 credit', run: hunterContacts }),
      step({ id: 'prospeo', label: 'Prospeo search + email', requires: ['PROSPEO_API_KEY'], cost: '1–2 credits', run: prospeoContacts }),
      step({ id: 'pdl', label: 'People Data Labs search', requires: ['PDL_API_KEY'], cost: '1 credit per person', run: pdlContacts }),
    ],
  },
  {
    id: 'verify_email',
    label: 'Verify email',
    description: 'Deliverability check. Returns valid | catch_all | risky | invalid | unknown.',
    inputs: ['email'],
    needs: [['email']],
    steps: [
      step({ id: 'smtp', label: 'SMTP mailbox check (free)', requires: [], cost: 'free', run: smtpVerifyStep }),
      step({ id: 'millionverifier', label: 'MillionVerifier', requires: ['MILLIONVERIFIER_API_KEY'], cost: '~$0.0004', run: v.millionVerifier }),
      step({ id: 'zerobounce', label: 'ZeroBounce', requires: ['ZEROBOUNCE_API_KEY'], cost: '~$0.008', run: v.zeroBounce }),
      step({ id: 'hunter', label: 'Hunter verifier', requires: ['HUNTER_API_KEY'], cost: '0.5 credit', run: v.hunterVerify }),
      step({ id: 'mx', label: 'Syntax + MX check (free)', requires: [], cost: 'free', run: (i) => free.mxVerify(i) }),
    ],
  },
  {
    id: 'mobile_phone',
    label: 'Find mobile phone',
    description: 'Mobile numbers mostly need a LinkedIn URL.',
    inputs: ['linkedinUrl', 'email', 'firstName', 'lastName', 'fullName', 'domain'],
    needs: [['linkedinUrl'], ['email'], ['fullName', 'domain']],
    steps: [
      step({ id: 'leadmagic', label: 'LeadMagic', requires: ['LEADMAGIC_API_KEY'], cost: '5 credits', run: v.leadmagicPhone }),
      step({ id: 'findymail', label: 'Findymail', requires: ['FINDYMAIL_API_KEY'], cost: '10 credits', run: v.findymailPhone }),
      step({ id: 'prospeo', label: 'Prospeo', requires: ['PROSPEO_API_KEY'], cost: '10 credits', run: v.prospeoPhone }),
      step({ id: 'pdl', label: 'People Data Labs', requires: ['PDL_API_KEY'], cost: '1 person credit', run: v.pdlPhone }),
    ],
  },
  {
    id: 'linkedin_url',
    label: 'Find LinkedIn profile',
    description: 'Person → LinkedIn URL. Search fallback is free.',
    inputs: ['firstName', 'lastName', 'fullName', 'companyName', 'domain', 'email'],
    needs: [['fullName'], ['firstName', 'lastName'], ['email']],
    steps: [
      step({ id: 'search', label: 'Web search (site:linkedin.com/in)', requires: [], cost: 'free / 1 search', run: free.searchLinkedin }),
      step({ id: 'apollo', label: 'Apollo', requires: ['APOLLO_API_KEY'], cost: '1 credit', run: v.apolloLinkedin }),
      step({ id: 'pdl', label: 'People Data Labs', requires: ['PDL_API_KEY'], cost: '1 person credit', run: v.pdlLinkedin }),
    ],
  },
  {
    id: 'person_profile',
    label: 'Enrich person',
    description: 'Title, company, location, history from email / LinkedIn / name+company.',
    inputs: ['email', 'linkedinUrl', 'firstName', 'lastName', 'fullName', 'domain', 'companyName'],
    needs: [['email'], ['linkedinUrl'], ['fullName', 'domain'], ['fullName', 'companyName']],
    steps: [
      step({ id: 'apollo', label: 'Apollo', requires: ['APOLLO_API_KEY'], cost: '1 credit', run: v.apolloProfile }),
      step({ id: 'pdl', label: 'People Data Labs', requires: ['PDL_API_KEY'], cost: '1 person credit', run: v.pdlProfile }),
    ],
  },
  {
    id: 'company_profile',
    label: 'Enrich company',
    description: 'Firmographics from a domain. Website scrape is free.',
    inputs: ['domain', 'companyName'],
    needs: [['domain'], ['companyName']],
    steps: [
      step({ id: 'yc', label: 'YC directory (free)', requires: [], cost: 'free', run: (i) => open.ycCompany(i) }),
      step({ id: 'wikidata', label: 'Wikidata (free)', requires: [], cost: 'free', run: open.wikidataCompany }),
      step({ id: 'apollo', label: 'Apollo', requires: ['APOLLO_API_KEY'], cost: '1 credit', run: v.apolloCompany }),
      step({ id: 'pdl', label: 'People Data Labs', requires: ['PDL_API_KEY'], cost: '1 company credit', run: v.pdlCompany }),
      step({ id: 'hunter', label: 'Hunter company', requires: ['HUNTER_API_KEY'], cost: '0.2 credit', run: v.hunterCompany }),
      step({ id: 'website', label: 'Website scrape (free)', requires: [], cost: 'free', run: (i) => free.websiteCompany(i) }),
    ],
  },
  {
    id: 'company_domain',
    label: 'Find company domain',
    description: 'Company name → website domain.',
    inputs: ['companyName'],
    needs: [['companyName']],
    steps: [
      step({ id: 'yc', label: 'YC directory (free)', requires: [], cost: 'free', run: async (i) => { const h = await open.ycCompany(i); return h?.data?.domain ? { value: h.data.domain, data: h.data } : null; } }),
      step({ id: 'wikidata', label: 'Wikidata (free)', requires: [], cost: 'free', run: open.wikidataDomain }),
      step({ id: 'apollo', label: 'Apollo', requires: ['APOLLO_API_KEY'], cost: 'free (search)', run: v.apolloDomain }),
      step({ id: 'search', label: 'Web search (free)', requires: [], cost: 'free / 1 search', run: free.searchDomain }),
    ],
  },
  {
    id: 'company_linkedin',
    label: 'Find company LinkedIn',
    description: 'Company → LinkedIn company page.',
    inputs: ['companyName', 'domain'],
    needs: [['companyName'], ['domain']],
    steps: [
      step({ id: 'wikidata', label: 'Wikidata (free)', requires: [], cost: 'free', run: open.wikidataLinkedin }),
      step({ id: 'website', label: 'Website footer link (free)', requires: [], cost: 'free', run: async (i) => { const h = await free.websiteCompany(i); const url = h?.data?.linkedin; return url ? { value: url } : null; } }),
      step({ id: 'search', label: 'Web search (free)', requires: [], cost: 'free / 1 search', run: free.searchCompanyLinkedin }),
    ],
  },
  {
    id: 'lookalike_companies',
    label: 'Find lookalike companies',
    description: 'Companies similar to this one, scored 0–100. Value = list of domains; details hold names, scores and reasons.',
    inputs: ['domain'],
    needs: [['domain']],
    steps: [lookalikeStep],
  },
];

export function enrichKind(id: string): EnrichKind {
  const k = ENRICH_KINDS.find((x) => x.id === id);
  if (!k) throw new Error(`Unknown enrichment: ${id}`);
  return k;
}
