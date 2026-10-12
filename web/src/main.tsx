import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App.tsx';
import './index.css';
import { reloadForNewBuild } from './components/RouteErrorBoundary.tsx';

// Vite fires this when a preloaded chunk of an older build is gone.
window.addEventListener('vite:preloadError', (e) => {
  if (reloadForNewBuild()) e.preventDefault();
});

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 15_000, refetchOnWindowFocus: true, retry: 1 } },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
