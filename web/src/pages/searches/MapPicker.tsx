import { useEffect, useRef } from 'react';
import type * as Leaflet from 'leaflet';

export interface BBox { south: number; west: number; north: number; east: number }
export interface LatLng { lat: number; lng: number }
export type Area = { kind: 'radius'; center: LatLng; radiusKm: number } | { kind: 'rect'; bbox: BBox };
export interface MapPoint { lat: number; lng: number; label: string }

/**
 * Leaflet + OpenStreetMap tiles (loaded on demand). In "radius" mode a click sets the
 * centre; in "rect" mode click-and-drag draws the search rectangle.
 */
export function MapPicker({ mode, area, onChange, points, focus, className }: {
  mode: 'radius' | 'rect';
  area: Area | null;
  onChange: (a: Area) => void;
  points?: MapPoint[];
  /** Pan/zoom here (e.g. after geocoding a city). */
  focus?: { center: LatLng; bbox?: BBox } | null;
  className?: string;
}) {
  const el = useRef<HTMLDivElement>(null);
  const L = useRef<typeof Leaflet | null>(null);
  const map = useRef<Leaflet.Map | null>(null);
  const shape = useRef<Leaflet.Layer | null>(null);
  const dots = useRef<Leaflet.LayerGroup | null>(null);
  const state = useRef({ mode, area, onChange });
  state.current = { mode, area, onChange };

  // Mount once.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [mod] = await Promise.all([import('leaflet'), import('leaflet/dist/leaflet.css')]);
      if (cancelled || !el.current) return;
      const lf = ((mod as any).default ?? mod) as typeof Leaflet;
      L.current = lf;
      const m = lf.map(el.current, { zoomControl: true, attributionControl: true }).setView([51.5, 10], 4);
      lf.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(m);
      dots.current = lf.layerGroup().addTo(m);
      map.current = m;

      let start: Leaflet.LatLng | null = null;
      let drawing: Leaflet.Rectangle | null = null;
      m.on('mousedown', (e: Leaflet.LeafletMouseEvent) => {
        if (state.current.mode !== 'rect') return;
        start = e.latlng;
        m.dragging.disable();
        drawing = lf.rectangle(lf.latLngBounds(start, start), { color: '#3b5bfd', weight: 2, fillOpacity: 0.08 }).addTo(m);
      });
      m.on('mousemove', (e: Leaflet.LeafletMouseEvent) => { if (start && drawing) drawing.setBounds(lf.latLngBounds(start, e.latlng)); });
      m.on('mouseup', () => {
        if (!start || !drawing) return;
        const b = drawing.getBounds();
        drawing.remove();
        start = null; drawing = null;
        m.dragging.enable();
        if (Math.abs(b.getNorth() - b.getSouth()) < 1e-4) return; // a click, not a drag
        state.current.onChange({ kind: 'rect', bbox: { south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() } });
      });
      m.on('click', (e: Leaflet.LeafletMouseEvent) => {
        if (state.current.mode !== 'radius') return;
        const r = state.current.area?.kind === 'radius' ? state.current.area.radiusKm : 5;
        state.current.onChange({ kind: 'radius', center: { lat: e.latlng.lat, lng: e.latlng.lng }, radiusKm: r });
      });
      draw();
    })();
    return () => { cancelled = true; map.current?.remove(); map.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function draw() {
    const lf = L.current, m = map.current;
    if (!lf || !m) return;
    shape.current?.remove();
    shape.current = null;
    const a = state.current.area;
    if (a?.kind === 'radius') shape.current = lf.circle([a.center.lat, a.center.lng], { radius: a.radiusKm * 1000, color: '#3b5bfd', weight: 2, fillOpacity: 0.06 }).addTo(m);
    if (a?.kind === 'rect') shape.current = lf.rectangle([[a.bbox.south, a.bbox.west], [a.bbox.north, a.bbox.east]], { color: '#3b5bfd', weight: 2, fillOpacity: 0.06 }).addTo(m);
  }

  useEffect(draw, [area]);

  useEffect(() => {
    const lf = L.current, m = map.current;
    if (!lf || !m || !focus) return;
    if (focus.bbox) m.fitBounds([[focus.bbox.south, focus.bbox.west], [focus.bbox.north, focus.bbox.east]], { maxZoom: 13 });
    else m.setView([focus.center.lat, focus.center.lng], 12);
  }, [focus]);

  useEffect(() => {
    const lf = L.current, g = dots.current;
    if (!lf || !g) return;
    g.clearLayers();
    for (const p of points ?? []) {
      if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) continue;
      lf.circleMarker([p.lat, p.lng], { radius: 4, color: '#f97316', weight: 1, fillOpacity: 0.8 }).bindTooltip(p.label).addTo(g);
    }
  }, [points]);

  return <div ref={el} className={`isolate ${className ?? 'h-80 w-full overflow-hidden rounded-lg border border-slate-200'}`} style={{ cursor: mode === 'rect' ? 'crosshair' : undefined }} />;
}
