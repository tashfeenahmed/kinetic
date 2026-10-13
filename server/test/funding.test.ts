import { afterEach, describe, expect, it } from 'vitest';
import { setHttpFetch } from '../src/gtm/lib/http.ts';
import { Db } from '../src/db/db.ts';
import { getSetting } from '../src/settings.ts';
import { fundingParams, fundingRounds, parseCountries } from '../src/sourcing/funding/index.ts';
import { matches, toRow, type FundingEvent } from '../src/sourcing/funding/common.ts';
import { parseFormD } from '../src/sourcing/funding/us.ts';
import { borPeople, bormeCompany, bormeEvent, parseBormeXml } from '../src/sourcing/funding/es.ts';
import { parseSogc, sogcPeople } from '../src/sourcing/funding/ch.ts';
import { capitalChanges, rolesPeople } from '../src/sourcing/funding/no.ts';
import { parseAdministration } from '../src/sourcing/funding/fr.ts';
import { capitalOf, drainStream, fetchUk, parseStreamLine } from '../src/sourcing/funding/uk.ts';

afterEach(() => setHttpFetch((...a) => globalThis.fetch(...a)));

const settings = (vals: Record<string, string> = {}) => ({ get: (k: string) => vals[k], has: (k: string) => !!vals[k] }) as any;
const noop = () => {};

const formD = (o: { name: string; industry: string; sold: number; offered?: number; amendment?: boolean; fund?: boolean }) => `<?xml version="1.0"?><edgarSubmission>
<primaryIssuer><cik>0000000001</cik><entityName>${o.name}</entityName><issuerAddress><street1>1 Main St</street1><city>SAN FRANCISCO</city><stateOrCountry>CA</stateOrCountry></issuerAddress>
<issuerPhoneNumber>4155550100</issuerPhoneNumber><entityType>Corporation</entityType></primaryIssuer>
<relatedPersonsList>
 <relatedPersonInfo><relatedPersonName><firstName>BOB</firstName><lastName>BOARD</lastName></relatedPersonName><relatedPersonRelationshipList><relationship>Director</relationship></relatedPersonRelationshipList><relationshipClarification></relationshipClarification></relatedPersonInfo>
 <relatedPersonInfo><relatedPersonName><firstName>Ada</firstName><lastName>Lovelace</lastName></relatedPersonName><relatedPersonRelationshipList><relationship>Executive Officer</relationship><relationship>Director</relationship></relatedPersonRelationshipList><relationshipClarification>CEO</relationshipClarification></relatedPersonInfo>
</relatedPersonsList>
<offeringData><industryGroup><industryGroupType>${o.industry}</industryGroupType></industryGroup>
<typeOfFiling><newOrAmendment><isAmendment>${o.amendment ? 'true' : 'false'}</isAmendment></newOrAmendment><dateOfFirstSale><value>2026-09-30</value></dateOfFirstSale></typeOfFiling>
<typesOfSecuritiesOffered><isEquityType>true</isEquityType>${o.fund ? '<isPooledInvestmentFundType>true</isPooledInvestmentFundType>' : ''}</typesOfSecuritiesOffered>
<offeringSalesAmounts><totalOfferingAmount>${o.offered ?? o.sold}</totalOfferingAmount><totalAmountSold>${o.sold}</totalAmountSold></offeringSalesAmounts></offeringData></edgarSubmission>`;

describe('US Form D', () => {
  it('parses amount, industry, city and puts the CEO first', () => {
    const ev = parseFormD(formD({ name: 'Acme AI, Inc.', industry: 'Other Technology', sold: 2_500_000, offered: 4_000_000 }), { cik: '0000000001', adsh: '0000000001-26-000001', filed: '2026-10-10' });
    expect(ev.company).toBe('Acme AI, Inc.');
    expect(ev.amountRaised).toBe(2_500_000);
    expect(ev.signal).toContain('Raised $2.5M of $4M');
    expect(ev.city).toBe('San Francisco, CA');
    expect(ev.people[0]).toMatchObject({ name: 'Ada Lovelace', title: 'CEO' });
    expect(ev.people[1].name).toBe('Bob Board');
    expect(ev.fund).toBe(false);
    expect(parseFormD(formD({ name: 'Blue Fund I, LP', industry: 'Pooled Investment Fund', sold: 1, fund: true }), { cik: '1', adsh: 'x', filed: '2026-10-10' }).fund).toBe(true);
  });

  it('runs end to end: skips funds and amendments, filters by sector, gives table rows', async () => {
    const docs: Record<string, string> = {
      '0000000001-26-000001': formD({ name: 'Acme AI, Inc.', industry: 'Other Technology', sold: 2_500_000 }),
      '0000000002-26-000001': formD({ name: 'Blue Fund I, LP', industry: 'Pooled Investment Fund', sold: 9_000_000, fund: true }),
      '0000000003-26-000001': formD({ name: 'Dental Group LLC', industry: 'Other Health Care', sold: 800_000 }),
      '0000000004-26-000001': formD({ name: 'Acme AI, Inc.', industry: 'Other Technology', sold: 3_000_000, amendment: true }),
    };
    const seen: string[] = [];
    setHttpFetch((async (input: any, init: any = {}) => {
      const url = String(input);
      seen.push(url);
      expect(init.headers['user-agent']).toBe('Test Co test@example.com');
      if (url.startsWith('https://efts.sec.gov/')) {
        return Response.json({ hits: { hits: Object.keys(docs).map((adsh, i) => ({ _id: `${adsh}:primary_doc.xml`, _source: { ciks: [String(i + 1).padStart(10, '0')], form: 'D', file_date: '2026-10-10', display_names: [`X (CIK ${i + 1})`] } })) } });
      }
      const adsh = Object.keys(docs).find((a) => url.includes(a.replace(/-/g, '')));
      return adsh ? new Response(docs[adsh]) : new Response('nope', { status: 404 });
    }) as typeof fetch);
    const ctx = { settings: settings({ SEC_USER_AGENT: 'Test Co test@example.com' }), log: noop };
    const all = await fundingRounds(ctx, { countries: 'us', days: 7 }, 10);
    expect(all.rows.map((r) => r.Company)).toEqual(['Acme AI, Inc.', 'Dental Group LLC']);
    expect(all.rows[0]).toMatchObject({ Country: 'United States', 'Amount raised': '$2.5M', 'Full name': 'Ada Lovelace', 'First name': 'Ada', Title: 'CEO', Source: 'SEC Form D' });
    expect(seen[0]).toContain('forms=D');
    const tech = await fundingRounds(ctx, { countries: 'us', query: 'tech' }, 10);
    expect(tech.rows.map((r) => r.Company)).toEqual(['Acme AI, Inc.']);
    const big = await fundingRounds(ctx, { countries: 'us', min_amount: 1_000_000 }, 10);
    expect(big.rows).toHaveLength(1);
  });

  it('reports a failing country as a warning without losing the others', async () => {
    setHttpFetch((async () => new Response('down', { status: 503 })) as typeof fetch);
    const r = await fundingRounds({ settings: settings(), log: noop }, { countries: 'us,uk' }, 10);
    expect(r.rows).toEqual([]);
    expect(r.warnings.join(' ')).toMatch(/United States: .*503/);
    expect(r.warnings.join(' ')).toMatch(/United Kingdom: .*COMPANIES_HOUSE_STREAM_KEY/);
  });
});

describe('Spain BORME', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?><documento><metadatos><titulo>MADRID</titulo></metadatos><texto>
    <p class="articulo">450748 - VETCARE SL.</p>
    <p class="parrafo">Ampliación de capital. Capital: 445,00 Euros. Resultante Suscrito: 6.469,00 Euros. Nombramientos. Con.Delegado: CLARASO VEGA NOE. Consejero: CARRIZO ARELLANO BENJAMIN;HOLDCO INVERSIONES SL. Apoderado: PEREZ ANA.  Datos registrales. S 8 , H M 870176, I/A 3 ( 2.10.26).</p>
    <p class="articulo">450749 - Q VISION TECNOLOGIES EUROPE SL.</p>
    <p class="parrafo">Cambio de denominación social. SQHEMA AI SL.  Datos registrales. S 8 , H M 772465.</p>
  </texto></documento>`;
  it('parses capital increases with the share of new stock and the appointed directors', () => {
    const entries = parseBormeXml(xml);
    expect(entries.map((e) => e.company)).toEqual(['VETCARE SL', 'Q VISION TECNOLOGIES EUROPE SL']);
    const ev = bormeEvent(entries[0], '2026-10-09', 'u')!;
    expect(ev).toMatchObject({ company: 'Vetcare', capitalBefore: 6024, capitalAfter: 6469, city: 'Madrid' });
    expect(toRow(ev)['New shares issued']).toBe('6.9%');
    expect(ev.people.map((p) => [p.name, p.title])).toEqual([['Noe Claraso Vega', 'CEO (Consejero Delegado)'], ['Benjamin Carrizo Arellano', 'Board Member']]);
    expect(bormeEvent(entries[1], '2026-10-09', 'u')).toBeNull();
  });
  it('cleans company names', () => {
    expect(bormeCompany('VALERO GREEN QUALITY, S.L(R.M. ALMERIA)')).toBe('Valero Green Quality');
    expect(bormeCompany('ACME SOLUTIONS SA.')).toBe('Acme Solutions');
    expect(bormeCompany('CONCORDIA LIFESTYLE DIGITAL SOCIEDAD LIMITADA.')).toBe('Concordia Lifestyle Digital');
    expect(borPeople('Nombramientos. Adm. Unico: RODRIGUEZ PUERTA JUAN JOSE.')[0]).toMatchObject({ firstName: 'Juan Jose', lastName: 'Rodriguez Puerta', title: 'Sole Director' });
  });
});

describe('Switzerland SOGC', () => {
  const pub = (nominalChanged: boolean, after: number, before: number) => `<HR02:publication xmlns:HR02="x"><meta><publicationDate>2026-10-13</publicationDate></meta><content>
  <publicationText>Carity AG, in Zuzwil, CHE-123.456.789, Aktiengesellschaft. Aktienkapital neu: CHF 214'492.00 [bisher: CHF 187'659.00]. Eingetragene Personen neu oder mutierend: Muster, Hans, deutscher Staatsangehöriger, in Zürich, Präsident des Verwaltungsrates, mit Kollektivunterschrift zu zweien; Revisia AG (CHE-1), in Bern, Revisionsstelle; Meier, Anna, von Basel, in Zug, Vorsitzende der Geschäftsleitung, mit Einzelunterschrift.</publicationText>
  <commonsNew><company><name>Carity AG</name><uid>CHE-123.456.789</uid><seat>Zuzwil (SG)</seat></company><purpose>Entwicklung von Software für Pflegeheime.</purpose><capital><nominal>${after}</nominal><paid>${after}</paid></capital></commonsNew>
  <commonsActual><company><name>Carity AG</name></company><capital><nominal>${before}</nominal></capital></commonsActual>
  <transaction><update><changements><capitalChanged><nominal>${nominalChanged}</nominal><paid>false</paid></capitalChanged></changements></update></transaction></content></HR02:publication>`;
  it('keeps nominal capital increases with before/after and the new officers', () => {
    const ev = parseSogc(pub(true, 214492, 187659), 'abc')!;
    expect(ev).toMatchObject({ company: 'Carity AG', capitalBefore: 187659, capitalAfter: 214492, currency: 'CHF', registryId: 'CHE-123.456.789', date: '2026-10-13' });
    expect(ev.people.map((p) => [p.name, p.title])).toEqual([['Anna Meier', 'CEO'], ['Hans Muster', 'Chair of the Board']]);
    expect(matches(ev, fundingParams({ sector: 'tech' }, 10))).toBe(true);
  });
  it('drops notices without a nominal increase', () => {
    expect(parseSogc(pub(false, 214492, 187659), 'a')).toBeNull();
    expect(parseSogc(pub(true, 100, 200), 'a')).toBeNull();
    expect(sogcPeople('no people here')).toEqual([]);
  });
});

describe('Norway Brønnøysund', () => {
  it('finds capital patches in the update feed and ranks CEO first', () => {
    const ch = capitalChanges([
      { organisasjonsnummer: '1', dato: '2026-10-09T08:00:00Z', endringer: [{ op: 'replace', path: '/kapital/belop', value: 31590 }, { op: 'replace', path: '/kapital/antallAksjer', value: 1053 }] },
      { organisasjonsnummer: '2', dato: '2026-10-09T08:00:00Z', endringer: [{ op: 'replace', path: '/epostadresse', value: 'a@b.no' }] },
    ]);
    expect(ch).toEqual([{ orgnr: '1', at: '2026-10-09', belop: 31590, shares: 1053 }]);
    const people = rolesPeople({ rollegrupper: [
      { roller: [{ type: { kode: 'LEDE' }, person: { navn: { fornavn: 'Kari', etternavn: 'Nordmann' } } }, { type: { kode: 'REVI' }, enhet: {} }] },
      { roller: [{ type: { kode: 'DAGL' }, person: { navn: { fornavn: 'Ola', mellomnavn: 'J', etternavn: 'Hansen' } } }, { type: { kode: 'MEDL' }, avregistrert: true, person: { navn: { fornavn: 'X', etternavn: 'Y' } } }] },
    ] });
    expect(people.map((p) => [p.name, p.title])).toEqual([['Ola J Hansen', 'CEO (Daglig leder)'], ['Kari Nordmann', 'Chair of the Board']]);
  });
});

describe('France BODACC', () => {
  it('reads people from the administration field and skips companies', () => {
    expect(parseAdministration('Président : DUPONT Jean ; Directeur général : MARTIN Claire Anne ; Commissaire aux comptes titulaire : KPMG SA').map((p) => [p.name, p.title]))
      .toEqual([['Jean Dupont', 'Président'], ['Claire Anne Martin', 'Directeur général']]);
    expect(parseAdministration('Président : PRIVUS INTERNATIONA')).toEqual([]);
  });
});

describe('UK Companies House', () => {
  const line = (type: string, timepoint: number, number = '12345678') => JSON.stringify({ resource_kind: 'filing-history', resource_uri: `/company/${number}/filing-history/MzAx`, resource_id: `t${timepoint}`, data: { type, category: 'capital', date: '2026-10-05', transaction_id: `t${timepoint}`, description_values: { capital: [{ figure: '1,250.50', currency: 'GBP' }], date: '2026-10-01' } }, event: { timepoint, published_at: '2026-10-12T10:00:00', type: 'changed' } });

  it('keeps SH01s from the stream and remembers the position', async () => {
    expect(capitalOf({ capital: [{ figure: '1,250.50', currency: 'GBP' }, { figure: '10', currency: 'GBP' }] })).toEqual({ amount: 1260.5, currency: 'GBP' });
    expect(parseStreamLine(line('AA', 5)).row).toBeUndefined();
    expect(parseStreamLine(line('SH01', 6)).row).toMatchObject({ company_number: '12345678', filed: '2026-10-05' });
    const db = new Db(':memory:');
    setHttpFetch((async (input: any, init: any) => {
      expect(String(input)).toContain('stream.companieshouse.gov.uk/filings');
      expect(init.headers.authorization).toBe(`Basic ${Buffer.from('streamkey:').toString('base64')}`);
      return new Response(`${line('AA', 1)}\n\n${line('SH01', 2)}\n${line('SH01', 3, '87654321')}\n`);
    }) as typeof fetch);
    expect(await drainStream(db, 'streamkey', 2000)).toBe(2);
    expect(getSetting(db, 'ch_stream_timepoint')).toBe('3');
    expect(await drainStream(db, 'streamkey', 2000)).toBe(0); // same events again: no duplicates

    setHttpFetch((async (input: any) => {
      const url = String(input);
      if (url.includes('/company/12345678/officers')) return Response.json({ items: [{ name: 'SMITH, John', officer_role: 'director', occupation: 'Director' }, { name: 'LOVELACE, Ada Augusta', officer_role: 'director', occupation: 'Chief Executive Officer' }, { name: 'OLD, Gone', officer_role: 'director', resigned_on: '2020-01-01' }] });
      if (url.includes('/company/12345678/filing-history')) return Response.json({ items: [{ transaction_id: 't2', date: '2026-10-05', description_values: { capital: [{ figure: '1,250.50', currency: 'GBP' }] } }, { transaction_id: 'old', date: '2025-01-01', description_values: { capital: [{ figure: '1,000', currency: 'GBP' }] } }] });
      if (url.endsWith('/company/12345678')) return Response.json({ company_name: 'ACME ROBOTICS LTD', company_status: 'active', type: 'ltd', date_of_creation: '2022-01-01', sic_codes: ['62012'], registered_office_address: { locality: 'LONDON' } });
      if (url.endsWith('/company/87654321')) return Response.json({ company_name: 'NEWCO LTD', company_status: 'active', type: 'ltd', date_of_creation: '2026-09-20', sic_codes: ['62012'] });
      return new Response('{}', { status: 404 });
    }) as typeof fetch);
    const ctx = { settings: settings({ COMPANIES_HOUSE_STREAM_KEY: 'streamkey', COMPANIES_HOUSE_API_KEY: 'rest' }), log: noop, db };
    const evs = await fetchUk(fundingParams({ sector: 'tech' }, 10, new Date('2026-10-13T12:00:00Z')), ctx);
    expect(evs).toHaveLength(1); // NEWCO was incorporated weeks ago: founder allotment
    expect(evs[0]).toMatchObject({ company: 'Acme Robotics Ltd', capitalBefore: 1000, capitalAfter: 1250.5, city: 'London', industryCode: '62012' });
    expect(evs[0].people.map((p) => [p.name, p.title])).toEqual([['Ada Augusta Lovelace', 'Chief Executive Officer'], ['John Smith', 'Director']]);
    expect(toRow(evs[0])['New shares issued']).toBe('20.0%');
  });
});

describe('params and filters', () => {
  it('parses countries and sector shortcuts', () => {
    expect(parseCountries('all')).toEqual(['us', 'uk', 'fr', 'es', 'ch', 'no']);
    expect(parseCountries('France, spain,UK')).toEqual(['fr', 'es', 'uk']);
    expect(() => parseCountries('mars')).toThrow(/Unknown countries/);
    expect(fundingParams({ query: 'health' }, 10).sector).toBe('health');
    expect(fundingParams({ query: 'robots, drones' }, 10).keywords).toEqual(['robots', 'drones']);
    const p = fundingParams({ days: 3 }, 10, new Date('2026-10-13T12:00:00Z'));
    expect([p.since, p.until]).toEqual(['2026-10-10', '2026-10-13']);
  });
  it('matches words at word starts and prefers official industry codes', () => {
    const ev = (o: Partial<FundingEvent>): FundingEvent => ({ country: 'fr', company: 'X', date: '2026-10-10', signal: '', people: [], source: 's', ...o });
    const tech = fundingParams({ sector: 'tech' }, 10);
    expect(matches(ev({ text: 'techniques de pose' }), tech)).toBe(false);
    expect(matches(ev({ text: 'éditeur de logiciels' }), tech)).toBe(true);
    expect(matches(ev({ text: 'logiciels, cuisines', industryCode: '46.47Z' }), tech)).toBe(false);
    expect(matches(ev({ industryCode: '62.01Z' }), tech)).toBe(true);
    expect(matches(ev({ industryCode: '62.01Z' }), fundingParams({ industry_codes: '58,63' }, 10))).toBe(false);
  });
});
