import { useNavigate } from 'react-router';
import { useMemo, useState } from 'react';
import type { Catalog, ColumnType } from '../lib/api';
import { Icon } from './Icon';
import { useFunctions } from './LinkForms';

export interface Pick { type: ColumnType; kind?: string; name: string; config?: any }

interface Item extends Pick { cat: string; title: string; desc: string; free?: boolean; icon: string; /** Connections still needed before it can be added. */ missing?: string[] }

const CATS = ['All', 'AI', 'Outreach', 'People', 'Company', 'Email', 'Signals', 'Tables', 'Functions', 'Actions', 'Utilities'];
const ENRICH_CAT: Record<string, string> = {
  work_email: 'Email', verify_email: 'Email', mobile_phone: 'People', linkedin_url: 'People', person_profile: 'People',
  company_profile: 'Company', company_domain: 'Company', company_linkedin: 'Company',
};
const ACTION_ICON: Record<string, string> = { outreach_campaign: 'send', outreach_update_lead: 'user', slack: 'send', webhook: 'link', hubspot_contact: 'user', hubspot_company: 'building', salesforce: 'layers' };

export function EnrichmentPicker({ catalog, onPick, onClose }: { catalog: Catalog; onPick: (p: Pick) => void; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('All');
  const fns = useFunctions();
  const navigate = useNavigate();

  const items = useMemo<Item[]>(() => [
    { cat: 'AI', type: 'ai', name: 'AI research', title: 'AI research agent', desc: 'Ask anything about each row. Searches the web, reads pages, returns typed fields with sources.', icon: 'brain', free: false },
    ...catalog.enrich.map((k) => ({
      cat: ENRICH_CAT[k.id] ?? 'Company', type: 'enrich' as const, kind: k.id, name: k.label.replace(/^Find |^Enrich /, '').replace(/^./, (c) => c.toUpperCase()),
      title: k.label, desc: `${k.description} ${k.steps.length} provider${k.steps.length === 1 ? '' : 's'}: ${k.steps.map((s) => s.label.replace(/ \(.*\)/, '')).join(', ')}.`,
      icon: ENRICH_CAT[k.id] === 'Email' ? 'mail' : ENRICH_CAT[k.id] === 'People' ? 'user' : 'building',
      free: k.steps.some((s) => s.requires.length === 0),
      // Usable once any provider in the waterfall is connected.
      missing: k.steps.some((s) => s.ready) ? [] : [...new Set(k.steps.slice(0, 2).map((s) => s.label.replace(/ \(.*\)/, '')))],
    })),
    ...catalog.signals.map((k) => ({ cat: k.id === 'outreach_status' ? 'Outreach' : 'Signals', type: 'signal' as const, kind: k.id, name: k.label, title: k.label, desc: k.description, icon: 'radar', free: k.requires.length === 0, missing: k.missing ?? [] })),
    { cat: 'Tables', type: 'lookup', name: 'Lookup', title: 'Lookup from another table', desc: 'Find the matching row(s) in another table by domain, email, company name or exact value — return fields, a list, or a count.', icon: 'lookup', free: true },
    { cat: 'Tables', type: 'action', kind: 'send_to_table', name: 'Send to table', title: 'Send to table', desc: 'Write each row (or each item of a list, e.g. a company’s people) into another table, deduped by a key.', icon: 'tableOut', free: true },
    ...(fns.data ?? []).map((f) => ({ cat: 'Functions', type: 'function' as const, kind: `fn-${f.id}`, name: f.name, title: f.name, desc: `${f.description || `${f.definition.steps.length} steps → ${f.definition.outputs.map((o) => o.name).join(', ')}`} · v${f.version}`, icon: 'blocks', config: { functionId: f.id, version: f.version } })),
    { cat: 'Functions', type: 'function', kind: 'fn-new', name: 'Function', title: 'Use a saved function', desc: 'Run a reusable enrichment recipe from your Functions library. Map table columns to its inputs.', icon: 'blocks' },
    ...catalog.actions.filter((a) => a.id !== 'send_to_table').map((a) => ({ cat: a.id.startsWith('outreach_') ? 'Outreach' : 'Actions', type: 'action' as const, kind: a.id, name: a.label.replace(/^Send |: /g, ' ').trim(), title: a.label, desc: a.id === 'outreach_campaign' ? 'Create/update a lead from each row and add it to a campaign. Enrichment and AI columns become email variables.' : a.id === 'outreach_update_lead' ? 'Sync row data into the matching lead (custom variables for personalization) without adding to a campaign.' : a.ready ? 'Ready to use.' : 'Needs setup in Settings.', free: a.id.startsWith('outreach_') ? true : undefined, icon: ACTION_ICON[a.id] ?? 'send', missing: a.missing ?? [] })),
    { cat: 'Utilities', type: 'formula', name: 'Formula', title: 'Formula', desc: 'JavaScript over the row — clean names, build domains, score leads.', icon: 'fn', free: true },
    { cat: 'Utilities', type: 'extract', name: 'Field', title: 'Extract field', desc: 'Pull one field out of an enrichment, signal or AI result.', icon: 'extract', free: true },
    { cat: 'Utilities', type: 'http', name: 'HTTP API', title: 'HTTP API', desc: 'Call any REST API with row values and keep the response.', icon: 'code', free: true },
    { cat: 'Utilities', type: 'text', name: 'Text', title: 'Text column', desc: 'A plain input column you type or paste into.', icon: 'type', free: true },
  ], [catalog, fns.data]);

  const shown = items.filter((i) => (cat === 'All' || i.cat === cat) && (!q || `${i.title} ${i.desc} ${i.cat}`.toLowerCase().includes(q.toLowerCase())));
  const groups = CATS.slice(1).map((c) => [c, shown.filter((i) => i.cat === c)] as const).filter(([, list]) => list.length);

  return (
    <aside className="drawer">
      <header><h3>Add enrichment</h3><button className="ghost icon-btn sm" onClick={onClose}><Icon name="x" /></button></header>
      <div className="picker-search">
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search enrichments, signals, actions…" />
      </div>
      <div className="picker-cats">
        {CATS.map((c) => <button key={c} className={c === cat ? 'on' : ''} onClick={() => setCat(c)}>{c}</button>)}
      </div>
      <div className="picker-list">
        {groups.map(([g, list]) => (
          <div key={g}>
            <div className="picker-group">{g}</div>
            {list.map((i) => (
              i.missing?.length ? (
                // Not addable until its connection exists: point to Integrations instead.
                <button key={`${i.type}-${i.kind ?? i.title}`} className="picker-item needs-connect" onClick={() => { onClose(); navigate('/integrations'); }}
                  title={`Connect ${i.missing.join(' and ')} on the Integrations page to use this`}>
                  <span className={`ty ty-${i.type}`}><Icon name={i.icon} size={15} /></span>
                  <span><b>{i.title}</b><small>Needs {i.missing.join(' and ')} — connect it first.</small></span>
                  <span className="tag connect">Connect</span>
                </button>
              ) : (
                <button key={`${i.type}-${i.kind ?? i.title}`} className="picker-item" onClick={() => onPick({ type: i.type, kind: i.config || i.kind?.startsWith('fn-') ? undefined : i.kind, name: i.name, config: i.config })}>
                  <span className={`ty ty-${i.type}`}><Icon name={i.icon} size={15} /></span>
                  <span><b>{i.title}</b><small>{i.desc}</small></span>
                  {i.free && <span className="tag">Free</span>}
                </button>
              )
            ))}
          </div>
        ))}
        {!shown.length && <p className="hint" style={{ padding: 16 }}>Nothing matches “{q}”.</p>}
      </div>
    </aside>
  );
}
