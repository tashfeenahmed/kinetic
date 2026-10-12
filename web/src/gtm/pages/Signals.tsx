import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api, display } from '../lib/api';
import { Icon } from '../components/Icon';

const OUTREACH_TONE: Record<string, string> = { LEAD_INTERESTED: 'ty-action', LEAD_REPLIED: 'ty-enrich', EMAIL_BOUNCED: 'ty-ai', LEAD_UNSUBSCRIBED: 'ty-text', LEAD_FIRST_CONTACTED: 'ty-http' };

export function Signals() {
  const [items, setItems] = useState<any[] | null>(null);
  useEffect(() => {
    const load = () => api('/api/gtm/signals?limit=200').then(setItems).catch(() => setItems([]));
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-head">
          <div>
            <h1>Signals</h1>
            <div className="sub">Table signals that changed (new roles, headlines, filings, tech, pages) and outreach moments (first contact, replies, interest, bounces, unsubscribes).</div>
          </div>
        </div>
        {items === null ? <p className="muted">Loading…</p> : items.length === 0 ? (
          <div className="empty-state">
            <p style={{ margin: 0, color: 'var(--text)' }}>No changes yet</p>
            <p className="hint">Open a company table and click <b>Signals</b> to add monitors. Changes and outreach replies show up here as they happen.</p>
          </div>
        ) : (
          <div className="feed">
            {items.map((s, i) => (
              <Link key={i} className="feed-item" to={s.source === 'outreach' ? (s.replyId ? '/inbox' : s.campaignId ? `/campaigns/${s.campaignId}` : '/leads') : `/tables/${s.tableId}`} style={{ color: 'inherit', textDecoration: 'none' }}>
                {s.source === 'outreach' ? (
                  <>
                    <span className={`ty ${OUTREACH_TONE[s.event] ?? 'ty-action'}`}><Icon name={s.event === 'EMAIL_BOUNCED' ? 'alert' : s.event === 'LEAD_FIRST_CONTACTED' ? 'send' : 'mail'} size={14} /></span>
                    <div>
                      <div className="what"><b style={{ fontWeight: 600 }}>{String(s.row)}</b> · {s.label} <span className="muted">in {s.table}</span></div>
                      {s.to && <div className="delta">{String(s.to).slice(0, 240)}</div>}
                    </div>
                  </>
                ) : (
                  <>
                    <span className={`ty ty-${s.type}`}><Icon name={s.type === 'signal' ? 'radar' : s.type === 'ai' ? 'brain' : 'database'} size={14} /></span>
                    <div>
                      <div className="what"><b style={{ fontWeight: 600 }}>{String(s.row)}</b> · {s.column} <span className="muted">in {s.table}</span></div>
                      <div className="delta"><s>{display(s.from).slice(0, 140) || '∅'}</s> → {display(s.to).slice(0, 240) || '∅'}</div>
                    </div>
                  </>
                )}
                <time>{new Date(s.at).toLocaleString()}</time>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
