import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api.ts';

export interface Me {
  id: number;
  name: string;
  email: string;
  current_workspace_id: number;
  role: 'admin' | 'editor' | 'viewer';
  team: { id: number; name: string; role: string } | null;
}

interface AuthState {
  me: Me | null;
  loading: boolean;
  needsSetup: boolean;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthState>({ me: null, loading: true, needsSetup: false, refresh: async () => {} });

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['auth-status'], queryFn: () => api.get('/api/auth/status').then((r) => r.data as { needs_setup: boolean; authenticated: boolean }) });
  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => api.get('/api/users').then((r) => r.data as Me),
    enabled: !!status.data?.authenticated,
    retry: false,
  });

  useEffect(() => {
    const h = () => { qc.setQueryData(['auth-status'], { needs_setup: false, authenticated: false }); qc.removeQueries({ queryKey: ['me'] }); };
    window.addEventListener('kinetic:unauthorized', h);
    return () => window.removeEventListener('kinetic:unauthorized', h);
  }, [qc]);

  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['auth-status'] });
    await qc.invalidateQueries({ queryKey: ['me'] });
  };

  return (
    <AuthContext.Provider value={{
      me: status.data?.authenticated ? me.data ?? null : null,
      loading: status.isLoading || (!!status.data?.authenticated && me.isLoading),
      needsSetup: !!status.data?.needs_setup,
      refresh,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
