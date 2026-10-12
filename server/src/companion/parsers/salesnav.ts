/** Sales Navigator parsers (salesApiLeadSearch / salesApiAccountSearch `elements[]`). */
import type { ParseResult, Rec } from '../protocol.ts';
import { type Any, arr, asJson, clean, degree, first, get, isObj, linkedinCompanyUrl, linkedinProfileUrl, num, str, uniqBy } from './util.ts';

function paged(root: Any, records: Rec[]): ParseResult {
  const p = root?.paging ?? get(root, 'data.paging') ?? get(root, 'metadata.paging');
  const total = num(p?.total);
  const start = num(p?.start) ?? 0;
  const count = num(p?.count) ?? records.length;
  const next = start + count;
  const more = total != null ? next < total : records.length > 0;
  return { records, total, nextCursor: more && count > 0 && records.length > 0 ? next : null };
}

function elements(root: Any): Any[] {
  return arr(root?.elements ?? get(root, 'data.elements') ?? get(root, 'value.elements')).filter(isObj);
}

/** "urn:li:fs_salesProfile:(ACwAAA…,NAME_SEARCH,abcd)" → "ACwAAA…,NAME_SEARCH,abcd". */
function salesProfileKey(urn: string): string {
  return /fs_salesProfile:\(([^)]+)\)/.exec(urn)?.[1] ?? '';
}

function tenure(t: Any): string {
  if (!t) return '';
  const y = num(t.numYears) ?? 0;
  const m = num(t.numMonths) ?? 0;
  return [y ? `${y} yr${y > 1 ? 's' : ''}` : '', m ? `${m} mo${m > 1 ? 's' : ''}` : ''].filter(Boolean).join(' ');
}

export function parseLeads(raw: unknown): ParseResult {
  const root = asJson(raw);
  const records: Rec[] = [];
  for (const e of elements(root)) {
    const key = salesProfileKey(str(e.entityUrn));
    const firstName = str(e.firstName);
    const lastName = str(e.lastName);
    const fullName = first(e.fullName, [firstName, lastName].filter(Boolean).join(' '));
    if (!fullName) continue;
    const positions = arr(e.currentPositions);
    const pos = positions.find((p: Any) => p?.current !== false) ?? positions[0] ?? {};
    const flagship = first(e.flagshipProfileUrl, e.publicProfileUrl);
    records.push(clean({
      fullName, firstName, lastName,
      title: str(pos.title),
      company: first(pos.companyName, get(pos, 'companyUrnResolutionResult.name')),
      location: first(e.geoRegion, e.location),
      tenure: tenure(pos.tenureAtPosition) || tenure(pos.tenureAtCompany),
      salesNavUrl: key ? `https://www.linkedin.com/sales/lead/${key}` : '',
      profileUrl: flagship ? linkedinProfileUrl(flagship) : '',
      memberUrn: /fs_salesProfile:\(([^,]+),/.exec(str(e.entityUrn))?.[1] ? `urn:li:fsd_profile:${/fs_salesProfile:\(([^,]+),/.exec(str(e.entityUrn))![1]}` : '',
      connectionDegree: degree(e.degree),
      premium: typeof e.premium === 'boolean' ? e.premium : undefined,
      headline: str(e.summary).slice(0, 300) || undefined,
      companyUrl: /salesCompany:(\d+)/.exec(str(pos.companyUrn))?.[1] ? linkedinCompanyUrl(/salesCompany:(\d+)/.exec(str(pos.companyUrn))![1]) : '',
    }));
  }
  return paged(root, uniqBy(records, (r) => str(r.salesNavUrl)));
}

export function parseAccounts(raw: unknown): ParseResult {
  const root = asJson(raw);
  const records: Rec[] = [];
  for (const e of elements(root)) {
    const id = /(?:fs_salesCompany|salesCompany|company):(\d+)/.exec(str(e.entityUrn))?.[1] ?? '';
    const name = str(e.companyName ?? e.name);
    if (!name) continue;
    const range = e.employeeCountRange;
    records.push(clean({
      name,
      industry: str(e.industry),
      employeeCount: num(e.employeeDisplayCount) ?? num(e.employeeCount) ?? (typeof range === 'string' ? range : undefined),
      location: first(e.location, e.geoRegion, get(e, 'headquarters.city')),
      salesNavUrl: id ? `https://www.linkedin.com/sales/company/${id}` : '',
      companyUrl: id ? linkedinCompanyUrl(id) : '',
      description: str(e.description),
    }));
  }
  return paged(root, uniqBy(records, (r) => str(r.salesNavUrl) || str(r.name)));
}
