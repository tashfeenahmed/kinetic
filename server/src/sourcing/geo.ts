/** Small geometry helpers for map searches: boxes, radii and tiling. */

export interface LatLng { lat: number; lng: number }
/** A lat/lng rectangle (degrees). */
export interface BBox { south: number; west: number; north: number; east: number }

const EARTH_KM = 6371;
const rad = (d: number) => (d * Math.PI) / 180;

export function haversineKm(a: LatLng, b: LatLng): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** The square that contains a circle. */
export function bboxAround(c: LatLng, radiusKm: number): BBox {
  const dLat = radiusKm / 111.32;
  const dLng = radiusKm / (111.32 * Math.max(0.01, Math.cos(rad(c.lat))));
  return clampBox({ south: c.lat - dLat, north: c.lat + dLat, west: c.lng - dLng, east: c.lng + dLng });
}

export function clampBox(b: BBox): BBox {
  return {
    south: Math.max(-90, Math.min(b.south, b.north)), north: Math.min(90, Math.max(b.south, b.north)),
    west: Math.max(-180, Math.min(b.west, b.east)), east: Math.min(180, Math.max(b.west, b.east)),
  };
}

/** Width and height in km (measured through the middle of the box). */
export function boxSizeKm(b: BBox): { widthKm: number; heightKm: number } {
  const midLat = (b.south + b.north) / 2;
  return {
    widthKm: haversineKm({ lat: midLat, lng: b.west }, { lat: midLat, lng: b.east }),
    heightKm: haversineKm({ lat: b.south, lng: b.west }, { lat: b.north, lng: b.west }),
  };
}

export function inBox(p: LatLng, b: BBox): boolean {
  return p.lat >= b.south && p.lat <= b.north && p.lng >= b.west && p.lng <= b.east;
}

/** Split a box into rows × cols equal tiles (south-west first). */
export function splitBox(b: BBox, rows: number, cols: number): BBox[] {
  const out: BBox[] = [];
  const h = (b.north - b.south) / rows;
  const w = (b.east - b.west) / cols;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    out.push({ south: b.south + r * h, north: b.south + (r + 1) * h, west: b.west + c * w, east: b.west + (c + 1) * w });
  }
  return out;
}

/** Four quadrants of a box. */
export const quarter = (b: BBox) => splitBox(b, 2, 2);

/**
 * A grid of tiles no larger than `maxKm` a side, capped at `maxTiles`
 * (tiles grow past `maxKm` when the cap would be exceeded).
 */
export function tileBox(b: BBox, maxKm: number, maxTiles = 64): BBox[] {
  const { widthKm, heightKm } = boxSizeKm(b);
  let rows = Math.max(1, Math.ceil(heightKm / maxKm));
  let cols = Math.max(1, Math.ceil(widthKm / maxKm));
  while (rows * cols > maxTiles) {
    if (rows >= cols && rows > 1) rows--; else if (cols > 1) cols--; else break;
  }
  return splitBox(b, rows, cols);
}

export function parseBox(v: unknown): BBox | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const n = (k: string) => Number(o[k]);
  const box = { south: n('south'), west: n('west'), north: n('north'), east: n('east') };
  return Object.values(box).every(Number.isFinite) ? clampBox(box) : undefined;
}
