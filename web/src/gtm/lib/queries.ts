import { useQuery } from '@tanstack/react-query';
import { api, type Catalog } from './api';

export function useGtmCatalog() {
  return useQuery({ queryKey: ['gtm-catalog'], queryFn: () => api<Catalog>('/api/gtm/catalog'), staleTime: 60_000 });
}

export function useGtmTables() {
  return useQuery({ queryKey: ['gtm-tables'], queryFn: () => api<{ id: number; name: string; row_count: number; updated_at: string }[]>('/api/gtm/tables'), staleTime: 10_000 });
}
