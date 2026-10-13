import { Suspense, useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Users, Send, Inbox, AtSign, Flame, Clock, Puzzle, Code2, ChevronDown, Settings, HelpCircle, LogOut,
  PanelLeftClose, PanelLeft, Check, Plus, Pencil, Trash2, ChevronsUpDown, ChevronRight, Menu as MenuIcon, X, Home as HomeIcon, Radar, Table2, Eye, MessageSquareText, BookOpen, Bot, } from 'lucide-react';
import { useGtmTables } from '../gtm/lib/queries';
import { RouteErrorBoundary } from './RouteErrorBoundary.tsx';
import { api } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import { initials } from '../lib/format.ts';
import { cx, Button, Field, Input, Loading, Modal, useUi } from './ui.tsx';

// The sidebar follows how data moves: tables (research) → leads → campaigns → inbox.
// Outreach is that pipeline; Setup is what feeds it (mailboxes, knowledge, signals).
const OUTREACH_NAV = [
  { to: '/leads', label: 'Leads', icon: Users },
  { to: '/campaigns', label: 'Campaigns', icon: Send },
  { to: '/inbox', label: 'Master Inbox', icon: Inbox, badge: 'unread' as const },
  { to: '/automations', label: 'Automations', icon: Bot },
  { to: '/visitors', label: 'Visitors', icon: Eye },
];
const SETUP_NAV = [
  { to: '/sender-emails', label: 'Sender Emails', icon: AtSign },
  { to: '/warmup', label: 'Email Warmup', icon: Flame },
  { to: '/sending-schedule', label: 'Sending Schedule', icon: Clock },
  { to: '/knowledge', label: 'Knowledge', icon: BookOpen },
  { to: '/signals', label: 'Signals', icon: Radar },
];

const DEV_NAV = [
  { to: '/developers/docs', label: 'Documentation' },
  { to: '/developers/api', label: 'Developer API' },
  { to: '/developers/webhooks', label: 'Webhooks & Listeners' },
];

/** Kinetic mark: a rounded square of four horizontal stripes. */
export function Logo({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-label="Kinetic" role="img" className="shrink-0">
      <defs><clipPath id="k-logo"><rect width="24" height="24" rx="6.5" /></clipPath></defs>
      <g clipPath="url(#k-logo)">
        <rect width="24" height="6" fill="#3b5bfd" /><rect y="6" width="24" height="6" fill="#14b8a6" />
        <rect y="12" width="24" height="6" fill="#fbbf24" /><rect y="18" width="24" height="6" fill="#f97316" />
      </g>
    </svg>
  );
}

/** Account menu (bottom left): workspaces, settings, help, log out. */
function UserMenu({ collapsed }: { collapsed: boolean }) {
  const { me, refresh } = useAuth();
  const qc = useQueryClient();
  const { toast } = useUi();
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const navigate = useNavigate();
  const workspaces = useQuery({ queryKey: ['workspaces'], queryFn: () => api.get('/api/workspaces').then((r) => r.data as { id: number; name: string; role: string }[]), enabled: open });

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const switchTo = async (id: number) => {
    setOpen(false);
    if (id === me?.current_workspace_id) return;
    await api.post('/api/workspaces/switch-workspace', { team_id: id });
    qc.clear();
    await refresh();
    navigate('/');
  };
  const create = useMutation({
    mutationFn: () => api.post('/api/workspaces', { name }),
    onSuccess: async (r) => { setCreating(false); setName(''); toast('Workspace created'); await switchTo(r.data.id); },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const logout = async () => {
    setOpen(false);
    await api.post('/api/auth/logout');
    qc.clear();
    await refresh();
  };
  const go = (to: string) => { setOpen(false); navigate(to); };
  const row = 'flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[13px] text-zinc-700 hover:bg-zinc-50';

  return (
    <div className="border-t border-zinc-200/80 px-2 py-2">
      <button onClick={(e) => { setAnchor(e.currentTarget.getBoundingClientRect()); setOpen((o) => !o); }} title={collapsed ? `${me?.name} · ${me?.team?.name}` : undefined} aria-haspopup="menu" aria-expanded={open}
        className={cx('flex w-full items-center gap-2.5 rounded-[7px] px-1 py-1.5 text-left hover:bg-zinc-200/50', open && 'bg-zinc-200/50')}>
        <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-zinc-200 text-[11px] font-semibold text-zinc-700">{initials(me?.name ?? '')}</span>
        <span className={cx('min-w-0 flex-1 whitespace-nowrap transition-opacity duration-200', collapsed && 'opacity-0')}>
          <span className="block truncate text-[13px] font-medium text-zinc-800">{me?.name}</span>
          <span className="block truncate text-[11.5px] text-zinc-500">{me?.team?.name ?? 'Workspace'}</span>
        </span>
        <ChevronsUpDown className={cx('size-3.5 shrink-0 text-zinc-400 transition-opacity duration-200', collapsed && 'opacity-0')} />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onMouseDown={() => setOpen(false)} />
          <div role="menu" className="fixed z-50 w-60 rounded-lg border border-zinc-200 bg-white py-1 shadow-lg"
            style={anchor ? (collapsed ? { left: anchor.right + 8, bottom: window.innerHeight - anchor.bottom } : { left: anchor.left, bottom: window.innerHeight - anchor.top + 4 }) : undefined}>
            <div className="border-b border-zinc-100 px-3 pb-2 pt-1.5">
              <div className="truncate text-[13px] font-medium text-zinc-900">{me?.name}</div>
              <div className="truncate text-[12px] text-zinc-500">{me?.email}</div>
            </div>
            <div className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">Workspaces</div>
            <div className="max-h-48 overflow-y-auto">
              {workspaces.isLoading && <div className="px-3 py-1.5 text-[13px] text-zinc-400">Loading…</div>}
              {workspaces.data?.map((w) => (
                <button key={w.id} role="menuitem" onClick={() => switchTo(w.id)} className={row}>
                  <span className="flex size-5 shrink-0 items-center justify-center rounded bg-zinc-100 text-[10px] font-semibold text-zinc-600">{initials(w.name)}</span>
                  <span className="flex-1 truncate">{w.name}</span>
                  {w.id === me?.current_workspace_id && <Check className="size-4 text-zinc-900" />}
                </button>
              ))}
            </div>
            <button role="menuitem" onClick={() => { setOpen(false); setCreating(true); }} className={row}><Plus className="size-4 text-zinc-500" /> New workspace</button>
            <div className="my-1 border-t border-zinc-100" />
            <button role="menuitem" onClick={() => go('/settings')} className={row}><Settings className="size-4 text-zinc-500" /> Settings</button>
            <button role="menuitem" onClick={() => go('/help')} className={row}><HelpCircle className="size-4 text-zinc-500" /> Help & Support</button>
            <div className="my-1 border-t border-zinc-100" />
            <button role="menuitem" onClick={logout} className={row}><LogOut className="size-4 text-zinc-500" /> Log out</button>
          </div>
        </>
      )}

      <Modal open={creating} onClose={() => setCreating(false)} title="New workspace" description="Workspaces keep tables, leads, campaigns and mailboxes separate — one per client or brand." size="sm"
        footer={<><Button onClick={() => setCreating(false)}>Cancel</Button><Button variant="primary" loading={create.isPending} disabled={!name.trim()} onClick={() => create.mutate()}>Create workspace</Button></>}>
        <Field label="Name"><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Corp" onKeyDown={(e) => e.key === 'Enter' && name.trim() && create.mutate()} /></Field>
      </Modal>
    </div>
  );
}

const itemClass = (active: boolean) => cx(
  'flex h-8 items-center gap-2.5 whitespace-nowrap rounded-[7px] px-2.5 text-[13.5px] font-medium transition-colors',
  active ? 'bg-white text-zinc-900 shadow-sm ring-1 ring-zinc-200' : 'text-zinc-600 hover:bg-zinc-200/50 hover:text-zinc-900',
);
const fade = (collapsed: boolean) => cx('transition-opacity duration-200', collapsed && 'pointer-events-none opacity-0');

function NavItem({ to, label, icon: Icon, end, collapsed, badge, count }: { to: string; label: string; icon: any; end?: boolean; collapsed: boolean; badge?: number; count?: number }) {
  return (
    <NavLink to={to} end={end} title={collapsed ? label : undefined} className={({ isActive }) => itemClass(isActive)}>
      <Icon className="size-4 shrink-0" strokeWidth={1.75} />
      <span className={cx('min-w-0 flex-1 truncate', fade(collapsed))}>{label}</span>
      {!!badge && <span className={cx('rounded-full bg-zinc-900 px-1.5 text-[10.5px] font-semibold text-white', fade(collapsed))}>{badge > 99 ? '99+' : badge}</span>}
      {count != null && <span className={cx('text-[11.5px] font-normal text-zinc-400', fade(collapsed))}>{count}</span>}
    </NavLink>
  );
}

/** A sidebar section that can be folded away; remembered per browser. */
function useSection(id: string, activeInside: boolean) {
  const key = `k:nav:${id}`;
  const [open, setOpen] = useState(() => { try { return localStorage.getItem(key) !== 'closed'; } catch { return true; } });
  const toggle = () => setOpen((o) => { try { localStorage.setItem(key, o ? 'closed' : 'open'); } catch { /* private mode */ } return !o; });
  // Never hide the page you're on.
  return { open: open || activeInside, toggle };
}

/** Section heading; collapses to a short rule so the items below don't move. Click to fold the section. */
function SectionLabel({ children, action, collapsed, open, onToggle }: { children: ReactNode; action?: ReactNode; collapsed: boolean; open?: boolean; onToggle?: () => void }) {
  return (
    <div className="group/sec relative flex h-[38px] items-end justify-between whitespace-nowrap px-2.5 pb-1.5 text-[11px] font-semibold uppercase tracking-[.06em] text-zinc-400">
      {onToggle && !collapsed ? (
        <button onClick={onToggle} aria-expanded={open} className={cx('-ml-1 flex items-center gap-1 rounded px-1 uppercase tracking-[.06em] hover:text-zinc-600', fade(collapsed))}>
          {children}
          <ChevronDown className={cx('size-3 transition-transform', !open && '-rotate-90', open && 'opacity-0 group-hover/sec:opacity-100')} />
        </button>
      ) : <span className={fade(collapsed)}>{children}</span>}
      {action && <span className={fade(collapsed)}>{action}</span>}
      <span className={cx('absolute bottom-[11px] left-2.5 h-px w-4 bg-zinc-300 transition-opacity duration-200', collapsed ? 'opacity-100' : 'opacity-0')} />
    </div>
  );
}

function Sidebar({ collapsed, onToggle, onNavigate }: { collapsed: boolean; onToggle: () => void; onNavigate?: () => void }) {
  const { me, refresh } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [devOpen, setDevOpen] = useState(location.pathname.startsWith('/developers'));
  const qc = useQueryClient();
  const unread = useQuery({
    queryKey: ['unread-count'],
    queryFn: () => api.get('/api/replies', { folder: 'inbox', per_page: 1 }).then((r) => r.counts?.unread_inbox ?? 0),
    refetchInterval: 60_000,
  });
  const tables = useGtmTables();
  const inside = (items: { to: string }[]) => items.some((n) => location.pathname.startsWith(n.to));
  const outreach = useSection('outreach', inside(OUTREACH_NAV));
  const setup = useSection('setup', inside(SETUP_NAV));
  const tablesSec = useSection('tables', location.pathname.startsWith('/tables/'));
  const [menu, setMenu] = useState<{ id: number; name: string; x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState<{ id: number; name: string } | null>(null);
  const { toast, confirm } = useUi();
  const refreshTables = () => qc.invalidateQueries({ queryKey: ['gtm-tables'] });
  const rename = useMutation({
    mutationFn: (r: { id: number; name: string }) => api.patch(`/api/gtm/tables/${r.id}`, { name: r.name.trim() }),
    onSuccess: () => { setRenaming(null); toast('Table renamed'); void refreshTables(); },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const removeTable = async (t: { id: number; name: string }) => {
    if (!(await confirm({ title: `Delete “${t.name}”?`, message: 'All rows, columns and results in this table are deleted. Leads and campaigns are not affected.', confirmLabel: 'Delete table', danger: true }))) return;
    try {
      await api.del(`/api/gtm/tables/${t.id}`);
      toast('Table deleted');
      await refreshTables();
      if (location.pathname === `/tables/${t.id}`) navigate('/');
    } catch (e) { toast((e as Error).message, 'error'); }
  };

  return (
    <aside className={cx('flex h-full flex-col overflow-hidden border-r border-zinc-200/80 bg-[#fafafa] transition-[width] duration-200 ease-out motion-reduce:transition-none', collapsed ? 'w-[52px]' : 'w-[236px]')} onClick={(e) => { if ((e.target as HTMLElement).closest('a')) onNavigate?.(); }}>
      <div className="flex h-14 shrink-0 items-center whitespace-nowrap px-[10px]">
        {collapsed ? (
          <button onClick={onToggle} title="Expand sidebar" aria-label="Expand sidebar" className="group/logo relative flex size-8 shrink-0 items-center justify-center rounded-md hover:bg-zinc-200/60">
            <span className="transition-opacity group-hover/logo:opacity-0"><Logo size={24} /></span>
            <PanelLeft className="absolute size-4 text-zinc-600 opacity-0 transition-opacity group-hover/logo:opacity-100" />
          </button>
        ) : (
          <Link to="/" className="flex size-8 shrink-0 items-center justify-center"><Logo size={24} /></Link>
        )}
        <Link to="/" tabIndex={collapsed ? -1 : 0} className={cx('ml-1 text-[15px] font-semibold tracking-tight text-zinc-900', fade(collapsed))}>Kinetic</Link>
        <button onClick={onToggle} tabIndex={collapsed ? -1 : 0} className={cx('ml-auto hidden rounded-md p-1.5 text-zinc-500 hover:bg-zinc-200/60 lg:block', fade(collapsed))} aria-label="Collapse sidebar" title="Collapse sidebar">
          <PanelLeftClose className="size-4" />
        </button>
      </div>
      {/* Padding lives inside the scroller, so the active item's ring and shadow aren't clipped. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden px-2 pb-2 scroll-thin">
        <nav className="mt-1 flex flex-col gap-px pt-px">
          <NavItem to="/" end label="Home" icon={HomeIcon} collapsed={collapsed} />
          <NavItem to="/agent" label="Agent" icon={MessageSquareText} collapsed={collapsed} />
        </nav>

        <SectionLabel collapsed={collapsed} open={outreach.open} onToggle={outreach.toggle}>Outreach</SectionLabel>
        {(outreach.open || collapsed) && (
          <nav className="flex flex-col gap-px">
            {OUTREACH_NAV.map((n) => <NavItem key={n.to} {...n} collapsed={collapsed} badge={n.badge === 'unread' ? unread.data : undefined} />)}
          </nav>
        )}

        <SectionLabel collapsed={collapsed} open={setup.open} onToggle={setup.toggle}>Setup</SectionLabel>
        {(setup.open || collapsed) && (
          <nav className="flex flex-col gap-px">
            {SETUP_NAV.map((n) => <NavItem key={n.to} {...n} collapsed={collapsed} />)}
          </nav>
        )}

        <SectionLabel collapsed={collapsed} open={tablesSec.open} onToggle={tablesSec.toggle}
          action={<button title="New table" onClick={() => navigate('/')} className="rounded p-0.5 text-zinc-400 hover:bg-zinc-200/60 hover:text-zinc-700"><Plus className="size-3.5" /></button>}>
          Tables{!tablesSec.open && tables.data?.length ? <span className="ml-1 font-normal normal-case tracking-normal">{tables.data.length}</span> : null}
        </SectionLabel>
        {(tablesSec.open || collapsed) && (
          <nav className="flex flex-col gap-px">
            {(tables.data ?? []).map((t) => (
              <div key={t.id} onContextMenu={(e) => { e.preventDefault(); setMenu({ id: t.id, name: t.name, x: e.clientX, y: e.clientY }); }}>
                <NavItem to={`/tables/${t.id}`} label={t.name} icon={Table2} collapsed={collapsed} count={t.row_count} />
              </div>
            ))}
            {!collapsed && tables.data?.length === 0 && <span className="px-2 py-1 text-[12.5px] text-zinc-400">No tables yet</span>}
          </nav>
        )}
      </div>

      <nav className="flex flex-col gap-px border-t border-zinc-200/80 px-2 py-2">
        <NavItem to="/integrations" label="Integrations" icon={Puzzle} collapsed={collapsed} />
        {collapsed ? (
          <NavItem to="/developers/api" label="Developers" icon={Code2} collapsed />
        ) : (
          <>
            <button onClick={() => setDevOpen((o) => !o)} className={itemClass(false)}>
              <Code2 className="size-4" strokeWidth={1.75} />
              <span className="flex-1 text-left">Developers</span>
              {devOpen ? <ChevronDown className="size-3.5 text-zinc-400" /> : <ChevronRight className="size-3.5 text-zinc-400" />}
            </button>
            {devOpen && DEV_NAV.map((d) => (
              <NavLink key={d.to} to={d.to} className={({ isActive }) => cx('ml-[26px] flex h-7 items-center rounded-[7px] px-2 text-[13px]', isActive ? 'bg-white font-medium text-zinc-900 shadow-sm ring-1 ring-zinc-200' : 'text-zinc-600 hover:bg-zinc-200/50 hover:text-zinc-900')}>
                {d.label}
              </NavLink>
            ))}
          </>
        )}
      </nav>
      {menu && (
        <>
          <div className="fixed inset-0 z-40" onMouseDown={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} />
          <div className="fixed z-50 w-44 rounded-lg border border-zinc-200 bg-white py-1 shadow-lg" style={{ left: menu.x, top: Math.min(menu.y, window.innerHeight - 100) }}>
            <button className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-zinc-700 hover:bg-zinc-50" onClick={() => { setRenaming({ id: menu.id, name: menu.name }); setMenu(null); }}>
              <Pencil className="size-3.5" /> Rename
            </button>
            <button className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-red-600 hover:bg-red-50" onClick={() => { const t = menu; setMenu(null); void removeTable(t); }}>
              <Trash2 className="size-3.5" /> Delete
            </button>
          </div>
        </>
      )}
      <Modal open={!!renaming} onClose={() => setRenaming(null)} title="Rename table" size="sm"
        footer={<><Button onClick={() => setRenaming(null)}>Cancel</Button><Button variant="primary" loading={rename.isPending} disabled={!renaming?.name.trim()} onClick={() => renaming && rename.mutate(renaming)}>Rename</Button></>}>
        <Field label="Name">
          <Input autoFocus value={renaming?.name ?? ''} onChange={(e) => setRenaming((r) => r && { ...r, name: e.target.value })}
            onFocus={(e) => e.target.select()} onKeyDown={(e) => { if (e.key === 'Enter' && renaming?.name.trim()) rename.mutate(renaming); }} />
        </Field>
      </Modal>
      <UserMenu collapsed={collapsed} />
    </aside>
  );
}

export function AppLayout() {
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('k:sidebar') === 'collapsed');
  const [mobileOpen, setMobileOpen] = useState(false);
  const toggle = () => setCollapsed((c) => { localStorage.setItem('k:sidebar', c ? 'open' : 'collapsed'); return !c; });
  return (
    <div className="flex h-full">
      <div className="hidden lg:block"><Sidebar collapsed={collapsed} onToggle={toggle} /></div>
      {mobileOpen && (
        <div className="fixed inset-0 z-40 flex bg-slate-900/30 lg:hidden" onMouseDown={(e) => e.target === e.currentTarget && setMobileOpen(false)}>
          <Sidebar collapsed={false} onToggle={() => setMobileOpen(false)} onNavigate={() => setMobileOpen(false)} />
          <button className="m-3 h-fit rounded-md bg-white p-1.5" onClick={() => setMobileOpen(false)} aria-label="Close menu"><X className="size-5" /></button>
        </div>
      )}
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex h-12 items-center border-b border-slate-200 px-4 lg:hidden">
          <button onClick={() => setMobileOpen(true)} className="rounded-md p-1.5 hover:bg-slate-100" aria-label="Open menu"><MenuIcon className="size-5" /></button>
          <span className="ml-3"><Logo size={22} /></span>
          <span className="ml-2 font-semibold">Kinetic</span>
        </div>
        <div className="flex-1 overflow-y-auto scroll-thin">
          {/* Keeps the sidebar on screen while a page's code loads. */}
          <RouteErrorBoundary key={location.pathname}>
            <Suspense fallback={<Loading />}>
              <Outlet />
            </Suspense>
          </RouteErrorBoundary>
        </div>
      </main>
    </div>
  );
}

/** Breadcrumbs + title + actions, as in the campaign view. */
export function PageHeader({ crumbs, title, badge, subtitle, actions }: { crumbs?: { label: string; to?: string }[]; title: ReactNode; badge?: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6">
      {crumbs && (
        <nav className="mb-4 flex items-center gap-2 text-sm text-slate-600">
          {crumbs.map((c, i) => (
            <span key={i} className="flex items-center gap-2">
              {i > 0 && <ChevronRight className="size-3.5 text-slate-400" />}
              {c.to ? <Link to={c.to} className="font-medium text-slate-800 hover:text-brand-600">{c.label}</Link> : <span className="truncate">{c.label}</span>}
            </span>
          ))}
        </nav>
      )}
      <div className="flex flex-col gap-4 border-b border-slate-200 pb-6 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{title}</h1>
            {badge}
          </div>
          {subtitle && <p className="mt-1 text-[15px] text-slate-500">{subtitle}</p>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

export function Page({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return <div className={cx('mx-auto w-full px-4 py-6 sm:px-8 sm:py-8', wide ? 'max-w-[1600px]' : 'max-w-7xl')}>{children}</div>;
}
