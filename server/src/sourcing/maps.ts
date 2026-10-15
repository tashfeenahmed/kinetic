/**
 * Local business search ("Google Maps" source).
 *
 * Keyed: Google Places API (New) Text Search with a field mask (cost is set by the
 * fields asked for) and a location rectangle. Text Search returns at most 60 places
 * (3 pages × 20) per query, so a box that hits the cap is split into quadrants and
 * searched again, down to `maxTiles` requests.
 *
 * Free: OpenStreetMap. Nominatim geocodes the location, Overpass returns shops,
 * amenities, offices and crafts matching the category tags or the name. Both are
 * community services: one request at a time, ~1/s, with an identifying User-Agent.
 */
import { getJson, HttpError, request } from '../gtm/lib/http.ts';
import type { Settings } from '../gtm/settings.ts';
import { HttpError as ApiError } from '../http.ts';
import { bboxAround, boxSizeKm, haversineKm, inBox, parseBox, quarter, tileBox, type BBox, type LatLng } from './geo.ts';
import { ownDomain } from './normalize.ts';

export interface MapsQuery {
  /** Category or keywords: "dentist", "coffee shop", "shop=bakery". */
  query: string;
  /** City or address, geocoded with Nominatim. */
  location?: string;
  center?: LatLng;
  radiusKm?: number;
  /** A drawn rectangle; wins over location/center. */
  bbox?: BBox;
  limit?: number;
  provider?: 'auto' | 'google' | 'osm';
  /** Google field set: basic (cheaper SKU) or contact (adds phone, website, rating). */
  fields?: 'basic' | 'contact';
  /** Cap on tile requests (Google: one per page; OSM: one per tile). */
  maxTiles?: number;
}

export interface MapsResult {
  provider: 'google' | 'osm';
  area: { bbox: BBox; center?: LatLng; radiusKm?: number; label?: string };
  tiles: number;
  requests: number;
  capped: boolean;
  rows: Record<string, unknown>[];
}

interface Deps { settings: Settings; log?: (m: string) => void }

// ---------- polite queues for community APIs ----------
let politeGapMs = 1100;
let retryDelayMs = 5_000;
/** Tests set this to 0 (also skips the wait before re-trying busy Overpass servers). */
export function setPoliteDelay(ms: number) { politeGapMs = ms; retryDelayMs = Math.min(ms * 5, 5_000); }
const chains = new Map<string, Promise<unknown>>();
function polite<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(name) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  chains.set(name, next.then(() => sleep(politeGapMs), () => sleep(politeGapMs)));
  return next;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Nominatim asks for a contact; some Overpass mirrors refuse agents that carry one, so Overpass gets the project URL only. */
function userAgent(settings: Settings, contact = true) {
  const who = contact ? settings.get('SEC_USER_AGENT') : undefined;
  return `Kinetic/0.1 (+https://github.com/tashfeenahmed/kinetic${who ? `; ${who}` : ''})`;
}

// ---------- geocoding ----------
const geoCache = new Map<string, { at: number; v: Geocoded | null }>();
export interface Geocoded { lat: number; lng: number; bbox: BBox; label: string }

export async function geocode(q: string, settings: Settings): Promise<Geocoded | null> {
  const key = q.trim().toLowerCase();
  if (!key) return null;
  const hit = geoCache.get(key);
  if (hit && Date.now() - hit.at < 86_400_000) return hit.v;
  const d = await polite('nominatim', () => getJson<any[]>('https://nominatim.openstreetmap.org/search', {
    headers: { 'user-agent': userAgent(settings), 'accept-language': 'en' },
    query: { q, format: 'jsonv2', limit: 1 },
    timeoutMs: 20_000,
    direct: true, // OpenStreetMap's usage policy wants a stable, identifiable client
  }));
  const r = d?.[0];
  // boundingbox is [south, north, west, east] as strings.
  const v = r ? { lat: Number(r.lat), lng: Number(r.lon), label: r.display_name, bbox: { south: Number(r.boundingbox[0]), north: Number(r.boundingbox[1]), west: Number(r.boundingbox[2]), east: Number(r.boundingbox[3]) } } : null;
  geoCache.set(key, { at: Date.now(), v });
  return v;
}

/** The search area: drawn box, else centre/location + radius, else the location's own bounds. */
export async function resolveArea(q: MapsQuery, settings: Settings): Promise<MapsResult['area']> {
  const box = parseBox(q.bbox);
  if (box) return { bbox: box };
  let center = q.center && Number.isFinite(q.center.lat) && Number.isFinite(q.center.lng) ? q.center : undefined;
  let label: string | undefined;
  let own: BBox | undefined;
  if (!center && q.location?.trim()) {
    const g = await geocode(q.location, settings);
    if (!g) throw Object.assign(new Error(`Couldn't find the location "${q.location}"`), { statusCode: 400 });
    center = { lat: g.lat, lng: g.lng };
    label = g.label;
    own = g.bbox;
  }
  if (!center) throw Object.assign(new Error('Give a location (city or address), a centre + radius, or draw a rectangle'), { statusCode: 400 });
  if (q.radiusKm && q.radiusKm > 0) return { bbox: bboxAround(center, q.radiusKm), center, radiusKm: q.radiusKm, label };
  // A point address has a tiny box; search 5 km around it instead.
  if (!own || boxSizeKm(own).widthKm < 1) return { bbox: bboxAround(center, 5), center, radiusKm: 5, label };
  return { bbox: own, center, label };
}

export async function mapsSearch(q: MapsQuery, deps: Deps): Promise<MapsResult> {
  const provider = q.provider === 'google' || (q.provider !== 'osm' && deps.settings.has('GOOGLE_MAPS_API_KEY')) ? 'google' : 'osm';
  if (provider === 'google' && !deps.settings.has('GOOGLE_MAPS_API_KEY')) {
    throw Object.assign(new Error('No Google Maps key is saved. A workspace admin can add one under Integrations → Data, AI & CRM providers → Google Maps (Places API). Until then, use provider "auto" or "osm" (free OpenStreetMap).'), { statusCode: 400 });
  }
  if (!q.query?.trim()) throw Object.assign(new Error('Say what kind of business to look for, e.g. "dentist"'), { statusCode: 400 });
  const area = await resolveArea(q, deps.settings);
  const limit = Math.min(Math.max(q.limit ?? 100, 1), 2000);
  const r = provider === 'google' ? await googleSearch(q, area.bbox, limit, deps) : await osmSearch(q, area.bbox, limit, deps);
  let rows = r.rows;
  // Rectangles are searched; a radius search keeps only what is inside the circle.
  if (area.center && area.radiusKm && !q.bbox) rows = rows.filter((x) => haversineKm(area.center!, { lat: Number(x.Lat), lng: Number(x.Lng) }) <= area.radiusKm! * 1.02);
  return { provider, area, tiles: r.tiles, requests: r.requests, capped: r.capped, rows: rows.slice(0, limit) };
}

// ---------- Google Places API (New) ----------
const BASIC_FIELDS = ['places.id', 'places.displayName', 'places.formattedAddress', 'places.addressComponents', 'places.location', 'places.primaryType', 'places.primaryTypeDisplayName', 'places.googleMapsUri', 'places.businessStatus'];
const CONTACT_FIELDS = ['places.internationalPhoneNumber', 'places.nationalPhoneNumber', 'places.websiteUri', 'places.rating', 'places.userRatingCount'];
export const fieldMask = (fields: 'basic' | 'contact' = 'contact') => [...BASIC_FIELDS, ...(fields === 'contact' ? CONTACT_FIELDS : []), 'nextPageToken'].join(',');
const GOOGLE_PAGE = 20;
const GOOGLE_CAP = 60; // Text Search never returns more than 60 places per query

async function googleSearch(q: MapsQuery, bbox: BBox, limit: number, deps: Deps) {
  const key = deps.settings.get('GOOGLE_MAPS_API_KEY')!;
  const maxRequests = Math.min(q.maxTiles ?? 40, 200);
  const seen = new Map<string, Record<string, unknown>>();
  let requests = 0;
  let tiles = 0;
  let capped = false;

  /** All pages for one box; returns how many places the box held (≤ 60). */
  async function searchBox(box: BBox): Promise<number> {
    tiles++;
    let count = 0;
    let pageToken: string | undefined;
    do {
      if (requests >= maxRequests) { capped = true; return count; }
      requests++;
      const d = await getJson('https://places.googleapis.com/v1/places:searchText', {
        method: 'POST',
        headers: { 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': fieldMask(q.fields) },
        json: {
          textQuery: q.query, pageSize: GOOGLE_PAGE, pageToken,
          locationRestriction: { rectangle: { low: { latitude: box.south, longitude: box.west }, high: { latitude: box.north, longitude: box.east } } },
        },
      }).catch((e) => {
        if (e instanceof HttpError && (e.status === 403 || e.status === 400)) throw new Error(`Google Places: ${(e.body as any)?.error?.message ?? e.message}. Enable "Places API (New)" for this key.`);
        throw e;
      });
      for (const p of d.places ?? []) {
        count++;
        if (p.businessStatus === 'CLOSED_PERMANENTLY') continue;
        if (!seen.has(p.id)) seen.set(p.id, googleRow(p));
      }
      pageToken = d.nextPageToken;
    } while (pageToken && seen.size < limit);
    return count;
  }

  // Quadtree: a box that returned the full 60 probably holds more; split it.
  const queue: { box: BBox; depth: number }[] = [{ box: bbox, depth: 0 }];
  while (queue.length && seen.size < limit) {
    const { box, depth } = queue.shift()!;
    const n = await searchBox(box);
    if (n >= GOOGLE_CAP && depth < 6) queue.push(...quarter(box).map((b) => ({ box: b, depth: depth + 1 })));
    if (requests >= maxRequests) { capped = capped || queue.length > 0; break; }
  }
  deps.log?.(`google places: ${seen.size} places from ${tiles} tile(s), ${requests} request(s)`);
  return { rows: [...seen.values()].filter((r) => inBox({ lat: Number(r.Lat), lng: Number(r.Lng) }, bbox)), tiles, requests, capped };
}

function googleRow(p: any): Record<string, unknown> {
  const comp = (type: string) => (p.addressComponents ?? []).find((c: any) => c.types?.includes(type));
  const website = p.websiteUri ?? '';
  return {
    Company: p.displayName?.text ?? '',
    Category: p.primaryTypeDisplayName?.text ?? pretty(p.primaryType ?? ''),
    Address: p.formattedAddress ?? '',
    City: (comp('locality') ?? comp('postal_town') ?? comp('administrative_area_level_2'))?.longText ?? '',
    Country: comp('country')?.longText ?? '',
    Phone: p.internationalPhoneNumber ?? p.nationalPhoneNumber ?? '',
    Website: website,
    'Company domain': ownDomain(website),
    Rating: p.rating ?? '',
    Reviews: p.userRatingCount ?? '',
    Lat: p.location?.latitude,
    Lng: p.location?.longitude,
    'Maps URL': p.googleMapsUri ?? `https://www.google.com/maps/place/?q=place_id:${p.id}`,
    'Place ID': p.id,
    Source: 'Google Maps',
  };
}

// ---------- OpenStreetMap (Overpass) ----------
const BUSINESS_KEYS = ['shop', 'amenity', 'office', 'craft', 'healthcare', 'tourism', 'leisure', 'club'];

/** Common categories → OSM tags. Anything else is matched by name. */
const CATEGORY_TAGS: [RegExp, string[]][] = [
  [/restaurant|diner|bistro|eatery|trattoria/, ['amenity=restaurant']],
  [/caf[eé]|coffee/, ['amenity=cafe']],
  [/\bbars?\b|\bpubs?\b|tavern/, ['amenity=bar', 'amenity=pub']],
  [/fast ?food|burger|pizza|takeaway/, ['amenity=fast_food']],
  [/dentist|dental|orthodont/, ['amenity=dentist', 'healthcare=dentist']],
  [/doctor|clinic|medical|physician|\bgp\b/, ['amenity=doctors', 'amenity=clinic', 'healthcare=doctor', 'healthcare=clinic']],
  [/physio/, ['healthcare=physiotherapist']],
  [/pharmac|chemist|drugstore/, ['amenity=pharmacy']],
  [/\bvets?\b|veterinar/, ['amenity=veterinary']],
  [/\bgyms?\b|fitness|crossfit/, ['leisure=fitness_centre']],
  [/hotel|motel|hostel|guest ?house|b&b/, ['tourism=hotel', 'tourism=motel', 'tourism=hostel', 'tourism=guest_house']],
  [/lawyer|attorney|law ?firm|solicitor|notar/, ['office=lawyer', 'office=notary']],
  [/accountant|accounting|bookkeep|tax advis/, ['office=accountant', 'office=tax_advisor']],
  [/real ?estate|estate agen|realtor|letting/, ['office=estate_agent', 'shop=estate_agent']],
  [/insurance/, ['office=insurance']],
  [/architect/, ['office=architect']],
  [/software|it (company|services|consult)|tech(nology)? compan|web (design|agency)|developer/, ['office=it', 'office=software']],
  [/marketing|advertising|creative agency|pr agency/, ['office=advertising_agency', 'office=marketing']],
  [/consult/, ['office=consulting']],
  [/recruit|staffing|employment agency/, ['office=employment_agency']],
  [/plumb/, ['craft=plumber']],
  [/electrician/, ['craft=electrician']],
  [/carpent|joiner/, ['craft=carpenter']],
  [/roofer|roofing/, ['craft=roofer']],
  [/hvac|heating|air ?condition/, ['craft=hvac']],
  [/hair|barber/, ['shop=hairdresser']],
  [/beauty|nail|salon|\bspa\b/, ['shop=beauty', 'leisure=spa']],
  [/bakery|baker/, ['shop=bakery']],
  [/butcher/, ['shop=butcher']],
  [/florist|flower/, ['shop=florist']],
  [/car repair|mechanic|garage|auto repair|body shop/, ['shop=car_repair']],
  [/car dealer|used cars/, ['shop=car']],
  [/supermarket|grocer/, ['shop=supermarket', 'shop=convenience']],
  [/cloth|boutique|fashion|apparel/, ['shop=clothes', 'shop=boutique']],
  [/book ?(shop|store)/, ['shop=books']],
  [/optician|eyewear/, ['shop=optician']],
  [/jewel/, ['shop=jewelry']],
  [/furniture/, ['shop=furniture']],
  [/hardware|diy/, ['shop=hardware', 'shop=doityourself']],
  [/\bpet\b|pet (shop|store)/, ['shop=pet']],
  [/bike|bicycle|cycle shop/, ['shop=bicycle']],
  [/brewer/, ['craft=brewery']],
  [/winer|vineyard/, ['craft=winery']],
  [/photograph/, ['craft=photographer', 'shop=photo']],
  [/language school|tutor/, ['amenity=language_school']],
  [/driving school/, ['amenity=driving_school']],
  [/kindergarten|daycare|nursery|childcare/, ['amenity=kindergarten', 'amenity=childcare']],
  [/coworking|co-working/, ['amenity=coworking_space', 'office=coworking']],
  [/\bbanks?\b/, ['amenity=bank']],
  [/car wash/, ['amenity=car_wash']],
  [/laundr|dry clean/, ['shop=laundry', 'shop=dry_cleaning']],
  [/travel agen/, ['shop=travel_agency']],
  [/print/, ['shop=copyshop', 'craft=printer']],
  [/football|soccer/, ['club=sport&sport=soccer', 'leisure=sports_centre&sport=soccer']],
  [/rugby/, ['club=sport&sport=rugby_union', 'leisure=sports_centre&sport=rugby_union']],
  [/\bgaa\b|hurling|gaelic/, ['club=sport&sport=gaelic_games', 'leisure=sports_centre&sport=gaelic_games']],
  [/tennis|padel/, ['club=sport&sport=tennis', 'leisure=sports_centre&sport=tennis', 'leisure=sports_centre&sport=padel']],
  [/golf/, ['leisure=golf_course', 'club=sport&sport=golf']],
  [/swim/, ['leisure=sports_centre&sport=swimming', 'club=sport&sport=swimming']],
  [/martial|karate|judo|taekwondo|jiu.?jitsu|\bmma\b|boxing/, ['leisure=sports_centre&sport=martial_arts', 'club=sport&sport=martial_arts', 'leisure=sports_centre&sport=boxing']],
  [/dance|ballet/, ['leisure=dance', 'amenity=dancing_school']],
  [/yoga|pilates/, ['leisure=fitness_centre&sport=yoga', 'shop=yoga']],
  [/sports? (club|academy|centre|center)|athletic/, ['club=sport', 'leisure=sports_centre']],
];

const escOverpass = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Overpass QL for one box: category tags (or raw key=value) plus a name match. */
export function overpassQuery(query: string, b: BBox, max: number): string {
  const box = `(${b.south},${b.west},${b.north},${b.east})`;
  const q = query.trim().toLowerCase();
  const tags = new Set<string>();
  for (const part of q.split(',').map((x) => x.trim()).filter(Boolean)) {
    const raw = part.match(/^([a-z_:]+)\s*=\s*([a-z0-9_;:-]+)$/);
    if (raw) { tags.add(`${raw[1]}=${raw[2]}`); continue; }
    for (const [re, t] of CATEGORY_TAGS) if (re.test(part)) t.forEach((x) => tags.add(x));
  }
  // A tag set may need several tags at once ("club=sport&sport=soccer").
  const statements = [...tags].map((t) => `nwr${t.split('&').map((kv) => { const [k, v] = kv.split('='); return `["${escOverpass(k)}"="${escOverpass(v)}"]`; }).join('')}["name"]${box};`);
  // Name match for anything typed as words ("sushi", "yoga studio"), on business features only.
  const words = q.split(',').map((x) => x.trim()).filter((x) => x && !x.includes('='));
  if (words.length) {
    const re = words.map((w) => escRe(w)).join('|');
    statements.push(`nwr[~"^(${BUSINESS_KEYS.join('|')})$"~"."]["name"~"${escOverpass(re)}",i]${box};`);
  }
  return `[out:json][timeout:40];(${statements.join('')});out center tags ${Math.max(1, Math.min(max, 5000))};`;
}

/** Public Overpass servers; the main one rate-limits bursts, so busy answers move on to a mirror. */
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.openstreetmap.fr/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];

async function overpass(body: string, deps: Deps): Promise<any> {
  let last = '';
  // Each server once, then the main one again: at most ~3 minutes before saying it's busy.
  for (let attempt = 0; attempt < OVERPASS.length + 1; attempt++) {
    const url = OVERPASS[attempt % OVERPASS.length]!;
    if (attempt >= OVERPASS.length) await sleep(retryDelayMs);
    try {
      const res = await request(url, {
        method: 'POST', body, timeoutMs: 45_000, direct: true,
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': userAgent(deps.settings, false) },
      });
      const text = await res.text();
      if (res.ok) return JSON.parse(text);
      last = `${new URL(url).host} ${res.status}`;
      if (res.status !== 429 && res.status < 500) throw new ApiError(502, { error: 'provider_error', message: `OpenStreetMap search failed (${res.status}): ${text.slice(0, 200)}` });
    } catch (e) {
      if (e instanceof ApiError) throw e;
      last = `${new URL(url).host}: ${(e as Error).message}`;
    }
    deps.log?.(`overpass busy (${last}); trying ${attempt + 1 < OVERPASS.length ? 'a mirror' : 'again'}`);
  }
  throw new ApiError(503, { error: 'provider_busy', message: `OpenStreetMap's free servers are busy right now (${last}). Try again in a few minutes, search a smaller area, or add a Google Maps key on the Integrations page.` });
}

async function osmSearch(q: MapsQuery, bbox: BBox, limit: number, deps: Deps) {
  // Overpass has no result cap but times out on huge areas: search ≤ 20 km tiles.
  const tiles = tileBox(bbox, 20, Math.min(q.maxTiles ?? 16, 64));
  const seen = new Map<string, Record<string, unknown>>();
  let requests = 0;
  for (const tile of tiles) {
    if (seen.size >= limit) break;
    requests++;
    const body = `data=${encodeURIComponent(overpassQuery(q.query, tile, limit))}`;
    let d: any;
    try {
      d = await polite('overpass', () => overpass(body, deps));
    } catch (e) {
      // Keep what earlier tiles found rather than losing the whole search to one busy tile.
      if (seen.size) { deps.log?.(`overpass: stopped after ${requests - 1} tile(s): ${(e as Error).message}`); requests--; break; }
      throw e;
    }
    for (const el of d.elements ?? []) {
      const id = `${el.type}/${el.id}`;
      if (!seen.has(id) && el.tags?.name) seen.set(id, osmRow(el));
    }
  }
  deps.log?.(`overpass: ${seen.size} places from ${tiles.length} tile(s)`);
  return { rows: [...seen.values()], tiles: tiles.length, requests, capped: requests < tiles.length };
}

function osmRow(el: any): Record<string, unknown> {
  const t = el.tags ?? {};
  const key = BUSINESS_KEYS.find((k) => t[k]);
  const website = t.website ?? t['contact:website'] ?? t.url ?? '';
  const street = [t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' ');
  const cityLine = [t['addr:postcode'], t['addr:city']].filter(Boolean).join(' ');
  return {
    Company: t.name,
    Category: key ? pretty(t[key]) : '',
    Address: t['addr:full'] ?? [street, cityLine].filter(Boolean).join(', '),
    City: t['addr:city'] ?? '',
    Country: t['addr:country'] ?? '',
    Phone: t.phone ?? t['contact:phone'] ?? '',
    Website: website,
    'Company domain': ownDomain(website),
    Email: t.email ?? t['contact:email'] ?? '',
    Rating: '',
    Reviews: '',
    Lat: el.lat ?? el.center?.lat,
    Lng: el.lon ?? el.center?.lon,
    'Maps URL': `https://www.openstreetmap.org/${el.type}/${el.id}`,
    'OSM ID': `${el.type}/${el.id}`,
    Source: 'OpenStreetMap',
  };
}

const pretty = (s: string) => {
  const t = String(s).split(';')[0].replace(/_/g, ' ').trim();
  return t ? t[0].toUpperCase() + t.slice(1) : '';
};
