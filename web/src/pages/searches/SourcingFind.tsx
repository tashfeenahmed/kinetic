import { useMemo, useState, type ComponentType } from 'react';
import { useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BookmarkPlus, Circle, Loader2, Search, Square, TableProperties } from 'lucide-react';
import { api, errorMessage } from '../../lib/api.ts';
import { Badge, Button, Input, Select, Textarea, cx, useUi } from '../../components/ui.tsx';
import { useGtmTables } from '../../gtm/lib/queries.ts';
import { MapPicker, type Area, type BBox, type LatLng } from './MapPicker.tsx';
import { SaveSearchModal, type SearchDraft } from './SaveSearchModal.tsx';

type Row = Record<string, any>;
interface Preview { rows: Row[]; found: number; excluded: number; label: string; extra?: string; profile?: any }

/**
 * Find prospects → "Local businesses" (map search) and "Lookalikes" (companies or people
 * like your best accounts). Results preview first; then add to a table or save as a watcher.
 */
export function SourcingFind({ mode, modes, onMode }: {
  mode: 'local' | 'lookalikes';
  modes: Record<string, { label: string; icon: ComponentType<{ className?: string }>; hint: string }>;
  onMode: (m: any) => void;
}) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [draft, setDraft] = useState<SearchDraft | null>(null);
  const [saving, setSaving] = useState(false);

  return (
    <div id="find" className="scroll-mt-6 rounded-2xl border border-slate-200 bg-white p-4 shadow-[0_12px_40px_rgba(16,16,20,.08)]">
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <div className="mr-2 text-[15px] font-semibold text-slate-900">Find new prospects</div>
        {Object.entries(modes).map(([m, M]) => (
          <button key={m} onClick={() => { setPreview(null); onMode(m); }} className={cx('inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12.5px] font-medium', m === mode ? 'bg-brand-50 text-brand-700' : 'bg-slate-100 text-slate-600 hover:bg-slate-200/70')}>
            <M.icon className="size-3.5" />{M.label}
          </button>
        ))}
        <span className="flex-1" />
        <span className="hidden text-xs text-slate-400 sm:inline">{modes[mode]?.hint}</span>
      </div>
      {mode === 'local'
        ? <LocalPanel onPreview={setPreview} onDraft={setDraft} />
        : <LookalikePanel onPreview={setPreview} onDraft={setDraft} />}
      {preview && <PreviewTable preview={preview} draft={draft} onSave={() => setSaving(true)} />}
      {draft && <SaveSearchModal open={saving} onClose={() => setSaving(false)} draft={draft} />}
    </div>
  );
}

// ---------- local businesses ----------
function LocalPanel({ onPreview, onDraft }: { onPreview: (p: Preview | null) => void; onDraft: (d: SearchDraft) => void }) {
  const [query, setQuery] = useState('');
  const [location, setLocation] = useState('');
  const [shape, setShape] = useState<'radius' | 'rect'>('radius');
  const [area, setArea] = useState<Area | null>(null);
  const [focus, setFocus] = useState<{ center: LatLng; bbox?: BBox } | null>(null);
  const [radius, setRadius] = useState(5);
  const [provider, setProvider] = useState('auto');
  const [limit, setLimit] = useState(100);
  const [busy, setBusy] = useState<'' | 'geo' | 'search'>('');
  const [err, setErr] = useState('');
  const [points, setPoints] = useState<{ lat: number; lng: number; label: string }[]>([]);
  const sources = useQuery({ queryKey: ['sources'], queryFn: () => api.get('/api/sources') });
  const keyed = sources.data?.google_maps?.provider === 'google';

  async function locate() {
    if (!location.trim()) return;
    setBusy('geo'); setErr('');
    try {
      const g = await api.post<{ lat: number; lng: number; bbox: BBox }>('/api/sources/geocode', { q: location.trim() });
      setFocus({ center: { lat: g.lat, lng: g.lng }, bbox: g.bbox });
      if (shape === 'radius') setArea({ kind: 'radius', center: { lat: g.lat, lng: g.lng }, radiusKm: radius });
    } catch (e) { setErr(errorMessage(e)); } finally { setBusy(''); }
  }

  const params = (): Record<string, unknown> => {
    const p: Record<string, unknown> = { query: query.trim(), provider };
    if (area?.kind === 'rect') p.bbox = area.bbox;
    else if (area?.kind === 'radius') { p.center = area.center; p.radius_km = area.radiusKm; }
    else { p.location = location.trim(); p.radius_km = radius; }
    return p;
  };

  async function search() {
    if (!query.trim()) return setErr('Say what kind of business, e.g. "dentist" or "coffee shop"');
    if (!area && !location.trim()) return setErr('Type a city or address, click the map, or draw a rectangle');
    setBusy('search'); setErr(''); onPreview(null);
    try {
      const p = params();
      const r = await api.post<any>('/api/sources/google-maps/search', { ...p, limit });
      setPoints(r.rows.map((x: Row) => ({ lat: Number(x.Lat), lng: Number(x.Lng), label: x.Company })));
      onPreview({ rows: r.rows, found: r.found, excluded: r.excluded, label: r.provider === 'google' ? 'Google Maps' : 'OpenStreetMap', extra: `${r.tiles} tile${r.tiles === 1 ? '' : 's'}${r.capped ? ' · capped (raise max tiles or shrink the area)' : ''}` });
      onDraft({ name: `${query.trim()} · ${location.trim() || 'map area'}`.slice(0, 60), source: 'google_maps', params: p, max_results: limit });
    } catch (e) { setErr(errorMessage(e)); } finally { setBusy(''); }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,340px)_1fr]">
      <div className="space-y-3">
        <div>
          <label className="mb-1 block text-[12.5px] font-medium text-slate-600">Business type or keywords</label>
          <Input value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && search()} placeholder="dentist, coffee shop, plumber…" />
        </div>
        <div>
          <label className="mb-1 block text-[12.5px] font-medium text-slate-600">City or address</label>
          <div className="flex gap-1.5">
            <Input value={location} onChange={(e) => setLocation(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && locate()} placeholder="Berlin, Germany" />
            <Button onClick={locate} loading={busy === 'geo'} disabled={!location.trim()}>Go</Button>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <button onClick={() => { setShape('radius'); setArea(null); }} className={cx('inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12.5px] font-medium', shape === 'radius' ? 'bg-zinc-900 text-white' : 'bg-slate-100 text-slate-600')}><Circle className="size-3.5" />Radius</button>
          <button onClick={() => { setShape('rect'); setArea(null); }} className={cx('inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12.5px] font-medium', shape === 'rect' ? 'bg-zinc-900 text-white' : 'bg-slate-100 text-slate-600')}><Square className="size-3.5" />Draw rectangle</button>
        </div>
        {shape === 'radius' ? (
          <div>
            <label className="mb-1 flex justify-between text-[12.5px] font-medium text-slate-600"><span>Radius</span><span>{radius} km</span></label>
            <input type="range" min={1} max={50} value={radius} className="w-full accent-zinc-900"
              onChange={(e) => { const r = Number(e.target.value); setRadius(r); if (area?.kind === 'radius') setArea({ ...area, radiusKm: r }); }} />
            <p className="text-xs text-slate-400">Click the map to move the centre.</p>
          </div>
        ) : <p className="text-xs text-slate-500">Click and drag on the map to draw the search area. Large areas are split into tiles.</p>}
        <div className="grid grid-cols-2 gap-2">
          <Select value={provider} onChange={(e) => setProvider(e.target.value)}>
            <option value="auto">{keyed ? 'Google Maps' : 'OpenStreetMap (free)'}</option>
            {keyed && <option value="osm">OpenStreetMap (free)</option>}
          </Select>
          <Select value={String(limit)} onChange={(e) => setLimit(Number(e.target.value))}>
            {[50, 100, 250, 500, 1000].map((n) => <option key={n} value={n}>Up to {n}</option>)}
          </Select>
        </div>
        {!keyed && <p className="text-xs text-slate-400">Add a Google Maps key on Integrations for phones, websites and ratings (Google gives free monthly usage).</p>}
        <Button variant="primary" className="w-full" icon={<Search className="size-4" />} loading={busy === 'search'} onClick={search}>Search businesses</Button>
        {err && <p className="rounded-lg bg-amber-50 px-3 py-2 text-[13px] text-amber-900">{err}</p>}
      </div>
      <MapPicker mode={shape} area={area} onChange={setArea} focus={focus} points={points} className="h-[360px] w-full overflow-hidden rounded-lg border border-slate-200" />
    </div>
  );
}

// ---------- lookalikes ----------
function LookalikePanel({ onPreview, onDraft }: { onPreview: (p: Preview | null) => void; onDraft: (d: SearchDraft) => void }) {
  const [kind, setKind] = useState<'companies' | 'people'>('companies');
  const [seeds, setSeeds] = useState('');
  const [tableId, setTableId] = useState('');
  const [companies, setCompanies] = useState('');
  const [location, setLocation] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const tables = useGtmTables();
  const list = (s: string) => s.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);

  async function find() {
    setBusy(true); setErr(''); onPreview(null);
    try {
      if (kind === 'companies') {
        const p: Record<string, unknown> = { seeds: list(seeds), ...(tableId ? { table_id: Number(tableId) } : {}) };
        const r = await api.post<any>('/api/sources/lookalikes/companies', { ...p, limit: 50 });
        onPreview({ rows: r.rows, found: r.found, excluded: r.excluded, label: r.source, profile: r.profile });
        onDraft({ name: `Like ${list(seeds).slice(0, 2).join(', ') || 'table seeds'}`.slice(0, 60), source: 'company_lookalikes', params: p, max_results: 50 });
      } else {
        const p: Record<string, unknown> = { seeds: list(seeds), companies: list(companies), location: location.trim() || undefined, ...(tableId ? { table_id: Number(tableId) } : {}) };
        const r = await api.post<any>('/api/sources/lookalikes/people', { ...p, limit: 50 });
        onPreview({ rows: r.rows, found: r.found, excluded: r.excluded, label: r.source });
        onDraft({ name: `People like ${list(seeds)[0] ?? 'seeds'}`.slice(0, 60), source: 'people_lookalikes', params: p, max_results: 50 });
      }
    } catch (e) { setErr(errorMessage(e)); } finally { setBusy(false); }
  }

  return (
    <div className="space-y-3">
      <div className="flex gap-1.5">
        {(['companies', 'people'] as const).map((k) => (
          <button key={k} onClick={() => setKind(k)} className={cx('inline-flex h-7 items-center rounded-md px-2.5 text-[12.5px] font-medium', kind === k ? 'bg-zinc-900 text-white' : 'bg-slate-100 text-slate-600')}>{k === 'companies' ? 'Similar companies' : 'Similar people'}</button>
        ))}
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <label className="mb-1 block text-[12.5px] font-medium text-slate-600">{kind === 'companies' ? 'Seed companies (domains, one per line)' : 'Seed people (job titles, one per line)'}</label>
          <Textarea rows={3} value={seeds} onChange={(e) => setSeeds(e.target.value)} placeholder={kind === 'companies' ? 'stripe.com\nadyen.com' : 'VP Sales\nHead of Revenue Operations'} />
        </div>
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-[12.5px] font-medium text-slate-600">…or take seeds from a table</label>
            <Select value={tableId} onChange={(e) => setTableId(e.target.value)}>
              <option value="">No table</option>
              {tables.data?.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.row_count})</option>)}
            </Select>
          </div>
          {kind === 'people' && (
            <div className="grid grid-cols-2 gap-2">
              <Input value={companies} onChange={(e) => setCompanies(e.target.value)} placeholder="Target companies (optional)" />
              <Input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Location (optional)" />
            </div>
          )}
        </div>
      </div>
      <div className="flex items-center gap-3">
        <Button variant="primary" icon={<Search className="size-4" />} loading={busy} disabled={!seeds.trim() && !tableId} onClick={find}>Find lookalikes</Button>
        {busy && <span className="flex items-center gap-1.5 text-[13px] text-slate-500"><Loader2 className="size-3.5 animate-spin" />Profiling the seeds and searching — this can take a minute.</span>}
      </div>
      {err && <p className="rounded-lg bg-amber-50 px-3 py-2 text-[13px] text-amber-900">{err}</p>}
    </div>
  );
}

// ---------- preview ----------
const PREVIEW_COLS = ['Company', 'Full name', 'Title', 'Category', 'City', 'Company domain', 'Phone', 'Rating', 'Similarity', 'Similarity reason', 'Industry', 'Location'];

function PreviewTable({ preview, draft, onSave }: { preview: Preview; draft: SearchDraft | null; onSave: () => void }) {
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { toast } = useUi();
  const cols = useMemo(() => PREVIEW_COLS.filter((c) => preview.rows.some((r) => r[c] !== undefined && r[c] !== '')).slice(0, 7), [preview]);

  async function addToTable() {
    setBusy(true);
    try {
      const r = await api.post<{ id: number; rows: number }>('/api/sources/to-table', { name: draft?.name ?? 'Prospects', rows: preview.rows });
      await qc.invalidateQueries({ queryKey: ['gtm-tables'] });
      toast(`Added ${r.rows} rows`);
      navigate(`/tables/${r.id}`);
    } catch (e) { toast(errorMessage(e), 'error'); } finally { setBusy(false); }
  }

  return (
    <div className="mt-4 border-t border-slate-100 pt-4">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-[13.5px] font-medium text-slate-900">{preview.rows.length} results</span>
        <Badge>{preview.label}</Badge>
        {preview.excluded > 0 && <Badge tone="yellow">{preview.excluded} excluded</Badge>}
        {preview.extra && <span className="text-xs text-slate-400">{preview.extra}</span>}
        <span className="flex-1" />
        {draft && <Button size="sm" icon={<BookmarkPlus className="size-4" />} onClick={onSave}>Save as watcher</Button>}
        <Button size="sm" variant="primary" icon={<TableProperties className="size-4" />} loading={busy} disabled={!preview.rows.length} onClick={addToTable}>Add to new table</Button>
      </div>
      {preview.profile && (
        <div className="mb-2 flex flex-wrap items-center gap-1 text-xs text-slate-500">
          <span>Profile:</span>
          {preview.profile.keywords?.slice(0, 8).map((k: any) => <Badge key={k.term} tone="blue">{k.term}</Badge>)}
          {preview.profile.industries?.slice(0, 2).map((i: string) => <Badge key={i}>{i}</Badge>)}
          {preview.profile.summary && <span className="ml-1 italic">{preview.profile.summary}</span>}
        </div>
      )}
      {preview.rows.length === 0 ? <p className="py-6 text-center text-[13px] text-slate-500">Nothing found. Try a broader query or a bigger area.</p> : (
        <div className="max-h-80 overflow-auto rounded-lg border border-slate-200 scroll-thin">
          <table className="w-full text-left text-[13px]">
            <thead className="sticky top-0 bg-slate-50"><tr>{cols.map((c) => <th key={c} className="whitespace-nowrap px-3 py-2 font-medium text-slate-600">{c}</th>)}</tr></thead>
            <tbody>
              {preview.rows.slice(0, 200).map((r, i) => (
                <tr key={i} className="border-t border-slate-100">
                  {cols.map((c) => (
                    <td key={c} className="max-w-[260px] truncate px-3 py-1.5 text-slate-700" title={String(r[c] ?? '')}>
                      {c === 'Similarity' ? <span className="inline-flex items-center gap-1.5"><span className="h-1.5 w-12 overflow-hidden rounded bg-slate-100"><span className="block h-full bg-emerald-500" style={{ width: `${r[c]}%` }} /></span>{r[c]}</span> : String(r[c] ?? '')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
