/**
 * France: BODACC "modification" notices that mention the share capital (open data,
 * no key). The notice gives the new capital, the legal form, the activity and often
 * the managers; the government company directory (recherche-entreprises.api.gouv.fr,
 * no key) adds the NAF industry code and directors; the company's previous BODACC
 * notice gives the capital before, so reductions are dropped and the share of new
 * stock is known.
 */
import { getJson } from '../../gtm/lib/http.ts';
import { FUND_WORDS, mapLimit, money, nameCase, person, surnameFirst, type CountryFetcher, type FundingEvent, type Person } from './common.ts';

const BODACC = 'https://bodacc-datadila.opendatasoft.com/api/explore/v2.1/catalog/datasets/annonces-commerciales/records';
const COMPANY_FORMS = /actions simplifi|anonyme/i; // SAS, SASU, SA — the forms startups use

const parseJson = (s: unknown) => { try { return typeof s === 'string' ? JSON.parse(s) : s; } catch { return null; } };
const firstPerson = (lp: any) => { const p = parseJson(lp)?.personne; return Array.isArray(p) ? p[0] : p; };
const amount = (v: unknown) => Number(String(v ?? '').replace(/\s/g, '').replace(',', '.')) || undefined;

/** "Président : DUPONT Jean ; Directeur général : MARTIN Claire" → people (companies skipped). */
export function parseAdministration(s: string): Person[] {
  const out: Person[] = [];
  for (const part of String(s ?? '').split(/;|\.\s+(?=[A-ZÉ][a-zé]+\s*:)/)) {
    const m = part.match(/^\s*([^:]{2,60}?)\s*:\s*(.+?)\s*$/);
    if (!m) continue;
    const [, title, who] = m;
    // Companies acting as officers are written all in capitals; people as "DUPONT Jean".
    if (!/\p{Ll}/u.test(who) || /\b(sas|sasu|sarl|sa|sci|société|societe|holding|commissaire|cabinet|audit)\b/i.test(who) || /commissaire aux comptes/i.test(title)) continue;
    for (const name of who.split(/\s+(?:et|,)\s+/)) if (/\p{L}{2}/u.test(name)) out.push(surnameFirst(name.replace(/^(m\.|mme|mr|mrs|monsieur|madame)\s+/i, ''), nameCase(title)));
  }
  return out;
}

async function previousCapital(siren: string, before: string): Promise<number | undefined> {
  const d = await getJson(BODACC, { query: { where: `registre="${siren}" and dateparution<"${before}"`, order_by: 'dateparution desc', limit: 10, select: 'listepersonnes,dateparution' }, direct: true });
  for (const r of d?.results ?? []) {
    const c = amount(firstPerson(r.listepersonnes)?.capital?.montantCapital);
    if (c) return c;
  }
  return undefined;
}

export const fetchFr: CountryFetcher = async (p, ctx) => {
  const out: FundingEvent[] = [];
  const maxScan = Math.min(9900, Math.max(300, p.limit * 15));
  // Cheap text check before the per-company lookups (industry codes need the lookup first).
  const prefilter = !p.industryCodes.length && (p.keywords.length > 0 || !!p.sector);
  let scanned = 0;
  for (let offset = 0; out.length < p.limit && offset < maxScan; offset += 100) {
    const d = await getJson(BODACC, {
      direct: true,
      query: {
        where: `familleavis="modification" and dateparution>="${p.since}" and dateparution<="${p.until}" and search(modificationsgenerales,"capital")`,
        order_by: 'dateparution desc', limit: 100, offset,
      },
    });
    const rows: any[] = d?.results ?? [];
    scanned += rows.length;
    const candidates = rows.map((r) => ({ r, pm: firstPerson(r.listepersonnes) })).filter(({ pm }) => pm && COMPANY_FORMS.test(pm.formeJuridique ?? '') && amount(pm.capital?.montantCapital) && (p.includeFunds || !FUND_WORDS.test(`${pm.denomination} ${pm.activite ?? ''}`)));
    const events = await mapLimit(candidates, 3, async ({ r, pm }): Promise<FundingEvent | null> => {
      const siren = String(pm.numeroImmatriculation?.numeroIdentification ?? r.registre?.[0] ?? '').replace(/\s/g, '');
      const after = amount(pm.capital?.montantCapital)!;
      if (after < p.minCapital) return null;
      const ev: FundingEvent = {
        country: 'fr', company: nameCase(pm.denomination ?? r.commercant ?? ''), date: r.dateparution,
        capitalAfter: after, currency: 'EUR', signal: '', industry: pm.activite ? String(pm.activite).slice(0, 160) : undefined,
        city: nameCase(pm.adresseSiegeSocial?.ville ?? r.ville ?? ''), people: parseAdministration(pm.administration ?? ''),
        filingUrl: r.url_complete, registryId: siren ? `SIREN ${siren}` : undefined, source: 'BODACC', text: pm.activite,
      };
      if (prefilter && !p.keep(ev)) return null;
      try {
        const e = await getJson('https://recherche-entreprises.api.gouv.fr/search', { query: { q: siren, per_page: 1 }, direct: true });
        const co = (e?.results ?? []).find((x: any) => x.siren === siren);
        if (co) {
          ev.industryCode = co.activite_principale;
          if (co.etat_administratif === 'F') return null; // closed
          const dirs: Person[] = (co.dirigeants ?? []).filter((x: any) => x.type_dirigeant === 'personne physique' && x.nom).map((x: any) => person(String(x.prenoms ?? '').split(' ')[0], String(x.nom), x.qualite ? nameCase(x.qualite) : undefined));
          if (!ev.people.length) ev.people = dirs;
          ev.city ||= nameCase(co.siege?.libelle_commune ?? '');
        }
      } catch (err: any) { ctx.log(`recherche-entreprises ${siren}: ${err.message}`); }
      if (!p.keep(ev)) return null;
      try { ev.capitalBefore = siren ? await previousCapital(siren, r.dateparution) : undefined; } catch { /* keep without the before figure */ }
      if (ev.capitalBefore && ev.capitalBefore >= after) return null; // reduction or no change
      if (!p.includeFunds && ev.capitalBefore && (after - ev.capitalBefore) / after > 0.6) return null; // founders topping up, not an outside round
      ev.people.sort((a, b) => Number(/président|president|directeur général|gérant/i.test(b.title ?? '')) - Number(/président|president|directeur général|gérant/i.test(a.title ?? '')));
      ev.signal = ev.capitalBefore
        ? `Capital increase ${money(ev.capitalBefore, 'EUR')} → ${money(after, 'EUR')} (BODACC)`
        : `Share capital changed, now ${money(after, 'EUR')} (BODACC)`;
      return ev;
    });
    for (const ev of events) if (ev && out.length < p.limit) out.push(ev);
    if (rows.length < 100) break;
  }
  ctx.log(`France BODACC: ${out.length} companies (scanned ${scanned} capital notices ${p.since}…${p.until})`);
  return out;
};
