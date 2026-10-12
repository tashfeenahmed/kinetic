import { Component, type ReactNode } from 'react';

/** True when the error means "this tab is running an older build" (a lazy chunk is gone). */
export function isStaleBuildError(e: unknown): boolean {
  const m = String((e as Error)?.message ?? e);
  return /dynamically imported module|Importing a module script failed|error loading dynamically imported|Failed to fetch|ChunkLoadError|Unable to preload CSS/i.test(m);
}

/** Reload once to pick up the new build; the guard stops a reload loop if the server is really down. */
export function reloadForNewBuild(): boolean {
  try {
    const last = Number(sessionStorage.getItem('k:reloaded-at') ?? 0);
    if (Date.now() - last < 10_000) return false;
    sessionStorage.setItem('k:reloaded-at', String(Date.now()));
  } catch { /* storage unavailable: still reload once */ }
  window.location.reload();
  return true;
}

/**
 * Catches errors from a page so the sidebar keeps working. Keyed by the route
 * in the layout, so navigating away always clears the error.
 */
export class RouteErrorBoundary extends Component<{ children: ReactNode }, { error: unknown }> {
  state = { error: null as unknown };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  componentDidCatch(error: unknown) {
    if (isStaleBuildError(error)) reloadForNewBuild();
  }

  render() {
    if (!this.state.error) return this.props.children;
    const stale = isStaleBuildError(this.state.error);
    return (
      <div className="mx-auto mt-24 max-w-md px-6 text-center">
        <h2 className="text-lg font-semibold text-slate-900">{stale ? 'Kinetic was updated' : 'This page hit an error'}</h2>
        <p className="mt-2 text-sm text-slate-500">
          {stale ? 'Reloading to get the latest version…' : String((this.state.error as Error)?.message ?? this.state.error)}
        </p>
        <button onClick={() => window.location.reload()} className="mt-5 inline-flex h-9 items-center rounded-lg bg-zinc-900 px-4 text-sm font-medium text-white hover:bg-zinc-800">Reload</button>
      </div>
    );
  }
}
