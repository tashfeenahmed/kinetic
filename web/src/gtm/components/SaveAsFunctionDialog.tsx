import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { api, STEP_TYPES, TYPE_META, type Column } from '../lib/api';
import { Modal } from './Dialogs';
import { Icon } from './Icon';

/** Turn selected columns into a reusable function; the columns they read become its inputs. */
export function SaveAsFunctionDialog({ tableId, columns, initialIds, onClose, onDone }: { tableId: number; columns: Column[]; initialIds: number[]; onClose: () => void; onDone: () => void }) {
  const eligible = columns.filter((c) => (STEP_TYPES as string[]).includes(c.type));
  const [ids, setIds] = useState<number[]>(() => initialIds.filter((id) => eligible.some((c) => c.id === id)));
  const [name, setName] = useState(() => eligible.find((c) => c.id === initialIds[0])?.name ?? '');
  const [tags, setTags] = useState('');
  const [addColumn, setAddColumn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toggle = (id: number) => setIds((x) => (x.includes(id) ? x.filter((y) => y !== id) : [...x, id]));

  async function save() {
    setBusy(true);
    setError('');
    try {
      const r = await api<{ id: number }>('/api/gtm/functions/from-columns', {
        body: { tableId, columnIds: ids, name: name.trim(), tags: tags.split(',').map((t) => t.trim()).filter(Boolean), addColumn },
      });
      void qc.invalidateQueries({ queryKey: ['gtm-functions'] });
      onDone();
      navigate(`/settings/functions/${r.id}`);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Save columns as function" onClose={onClose} footer={<><span className="err">{error}</span><span style={{ flex: 1 }} /><button onClick={onClose}>Cancel</button><button className="primary" disabled={busy || !ids.length || !name.trim()} onClick={save}>{busy ? 'Saving…' : 'Create function'}</button></>}>
      <p className="hint">The selected columns become steps, in dependency order. Columns they read that you didn't select (e.g. <i>Company domain</i>) become the function's inputs; columns nothing else reads become its outputs. You can edit everything afterwards.</p>
      <label>Name<input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Company research" /></label>
      <label>Tags (comma-separated, optional)<input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="company, research" /></label>
      <label style={{ marginBottom: 0 }}>Columns</label>
      <div className="fn-cols">
        {eligible.length === 0 && <p className="hint">This table has no formula, extract, enrichment, AI, HTTP or lookup columns.</p>}
        {eligible.map((c) => (
          <label key={c.id} className="check">
            <input type="checkbox" checked={ids.includes(c.id)} onChange={() => toggle(c.id)} />
            <span className={`ty ty-${c.type}`}><Icon name={TYPE_META[c.type].icon} size={12} /></span> {c.name}
          </label>
        ))}
      </div>
      <label className="check"><input type="checkbox" checked={addColumn} onChange={(e) => setAddColumn(e.target.checked)} /> Also add a function column to this table, wired to the same inputs</label>
    </Modal>
  );
}
