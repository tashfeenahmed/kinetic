import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { api, errorMessage } from '../lib/api.ts';
import { useUi } from './ui.tsx';

/** Outreach → Tables: open leads as a Kinetic table (enrich, research, sync back). */
export function useOpenInTable() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { toast } = useUi();
  return useMutation({
    mutationFn: (sel: { lead_ids?: number[]; list_id?: number; campaign_id?: number; all?: boolean; name?: string }) =>
      api.post<{ id: number; rows: number }>('/api/gtm/tables/from-leads', sel),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['gtm-tables'] });
      toast(`Opened ${r.rows} lead${r.rows === 1 ? '' : 's'} in a table`);
      navigate(`/tables/${r.id}`);
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });
}
