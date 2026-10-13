/**
 * United States: SEC Form D (Regulation D exempt offerings — most VC/angel rounds).
 * EDGAR full-text search lists the filings for a date range (no key, a declared
 * User-Agent is required); each filing's primary_doc.xml has the amount sold, the
 * industry group, the business address and phone, and the executive officers/directors.
 */
import { getJson } from '../../gtm/lib/http.ts';
import { FUND_WORDS, getText, mapLimit, money, person, tag, tags, type CountryFetcher, type FundingEvent } from './common.ts';

/** Industry groups that are funds or property vehicles rather than operating companies. */
const NOT_COMPANIES = /^(Pooled Investment Fund|Investing|REITS and Finance|Residential|Commercial|Other Real Estate|Construction)$/;

export function parseFormD(xml: string, meta: { cik: string; adsh: string; filed: string }): FundingEvent & { amendment: boolean; fund: boolean } {
  const issuer = tags(xml, 'primaryIssuer')[0] ?? xml;
  const addr = tags(issuer, 'issuerAddress')[0] ?? '';
  const offering = tags(xml, 'offeringData')[0] ?? xml;
  const industry = tag(tags(offering, 'industryGroup')[0] ?? '', 'industryGroupType');
  const sold = Number(tag(offering, 'totalAmountSold')) || 0;
  const offered = Number(tag(offering, 'totalOfferingAmount')) || 0; // 0 when "Indefinite"
  const amount = sold || offered || undefined;
  const securities = tags(offering, 'typesOfSecuritiesOffered')[0] ?? '';
  const kinds = [/<isEquityType>true/.test(securities) && 'equity', /<isDebtType>true/.test(securities) && 'debt', /<isOptionToAcquireType>true|<isSecurityToBeAcquiredType>true/.test(securities) && 'options/SAFE', /<isPooledInvestmentFundType>true/.test(securities) && 'fund interests'].filter(Boolean);
  const amendment = /<isAmendment>true/.test(offering);
  const people = tags(xml, 'relatedPersonInfo').map((p) => {
    const roles = tags(p, 'relationship').map((r) => r.trim());
    const clar = tag(p, 'relationshipClarification');
    const title = clar && clar.length < 60 ? clar : roles.includes('Executive Officer') ? 'Executive Officer' : roles[0];
    return { p: person(tag(p, 'firstName'), tag(p, 'lastName'), title), exec: roles.includes('Executive Officer') };
  }).filter((x) => x.p.name && !/^n\/?a$/i.test(x.p.name));
  people.sort((a, b) => Number(b.exec) - Number(a.exec) || Number(/ceo|chief exec|founder|president/i.test(b.p.title ?? '')) - Number(/ceo|chief exec|founder|president/i.test(a.p.title ?? '')));
  const company = tag(issuer, 'entityName');
  const phone = tag(issuer, 'issuerPhoneNumber');
  const firstSale = tag(offering, 'dateOfFirstSale').match(/\d{4}-\d{2}-\d{2}/)?.[0];
  return {
    country: 'us',
    company,
    date: meta.filed,
    amountRaised: amount,
    currency: 'USD',
    signal: `${sold ? `Raised ${money(sold)}` : amount ? `Raising ${money(amount)}` : 'Raising (amount not stated)'}${offered && sold && offered > sold ? ` of ${money(offered)}` : ''} — Form D${amendment ? '/A' : ''}${kinds.length ? `, ${kinds.join(' + ')}` : ''}${firstSale ? `, first sale ${firstSale}` : ''}`,
    industry,
    city: [tag(addr, 'city'), tag(addr, 'stateOrCountry')].filter(Boolean).map((s) => s.length > 2 ? s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) : s).join(', '),
    phone: phone && phone.replace(/\D/g, '').length >= 10 ? phone : undefined,
    people: people.map((x) => x.p),
    filingUrl: `https://www.sec.gov/Archives/edgar/data/${Number(meta.cik)}/${meta.adsh.replace(/-/g, '')}/${meta.adsh}-index.htm`,
    registryId: `CIK ${Number(meta.cik)}`,
    source: 'SEC Form D',
    text: `${tag(issuer, 'entityType')} ${industry}`,
    amendment,
    fund: NOT_COMPANIES.test(industry) || /<isPooledInvestmentFundType>true/.test(securities) || FUND_WORDS.test(company),
  };
}

export const fetchUs: CountryFetcher = async (p, ctx) => {
  const ua = ctx.settings.get('SEC_USER_AGENT') || 'Kinetic research admin@example.com';
  const headers = { 'user-agent': ua, accept: 'application/json' };
  const out: FundingEvent[] = [];
  const maxScan = Math.min(1500, Math.max(200, p.limit * 8));
  let scanned = 0;
  for (let from = 0; out.length < p.limit && scanned < maxScan; from += 100) {
    const d = await getJson('https://efts.sec.gov/LATEST/search-index', {
      headers, direct: true,
      query: { forms: 'D', dateRange: 'custom', startdt: p.since, enddt: p.until, from, ...(p.region ? { locationCodes: p.region.toUpperCase() } : {}) },
    });
    const hits: any[] = d?.hits?.hits ?? [];
    if (!hits.length) break;
    // Quick filters from the search index before fetching each filing.
    const todo = hits.filter((h) => h._source?.form === 'D' && (p.includeFunds || !FUND_WORDS.test(String(h._source?.display_names?.[0] ?? ''))));
    scanned += hits.length;
    const parsed = await mapLimit(todo, 4, async (h) => {
      const [adsh, file] = String(h._id).split(':');
      const cik = String(h._source.ciks?.[0] ?? '');
      try {
        const xml = await getText(`https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${adsh.replace(/-/g, '')}/${file || 'primary_doc.xml'}`, { headers: { 'user-agent': ua } });
        return parseFormD(xml, { cik, adsh, filed: h._source.file_date });
      } catch (e: any) { ctx.log(`Form D ${adsh}: ${e.message}`); return null; }
    });
    for (const ev of parsed) {
      if (!ev || ev.amendment) continue;
      if (ev.fund && !p.includeFunds) continue;
      if ((ev.amountRaised ?? 0) < p.minAmount) continue;
      if (out.length < p.limit && p.keep(ev)) out.push(ev);
    }
    if (hits.length < 100) break;
  }
  ctx.log(`US Form D: ${out.length} companies (scanned ${scanned} filings ${p.since}…${p.until})`);
  return out;
};
