import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../lib/api';
import { Icon } from '../components/Icon';

export function Logs() {
  const [logs, setLogs] = useState<any[]>([]);
  useEffect(() => {
    const load = () => api('/api/gtm/activity?limit=300').then(setLogs).catch(() => {});
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-head"><div><div className="crumbs" style={{ marginBottom: 4 }}><Link to="/settings">Settings</Link><Icon name="chevronRight" size={14} /></div><h1>Activity log</h1><div className="sub">Provider calls, errors, webhooks and scheduled refreshes.</div></div></div>
        {logs.length === 0 ? <div className="empty-state">Nothing yet.</div> : (
          <table className="list">
            <thead><tr><th>Time</th><th>Level</th><th>Source</th><th>Table</th><th>Message</th></tr></thead>
            <tbody>{logs.map((l) => (
              <tr key={l.id} className={l.level}>
                <td className="muted nowrap">{new Date(l.at).toLocaleString()}</td><td>{l.level}</td><td>{l.source}</td>
                <td>{l.table_id ? <Link to={`/tables/${l.table_id}`}>#{l.table_id}</Link> : ''}</td><td>{l.message}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
    </div>
  );
}
