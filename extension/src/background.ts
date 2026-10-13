/**
 * Service worker: keeps the pairing, heartbeats and polls Kinetic for tasks, opens (or reuses)
 * one dedicated tab per site, hands each task to that tab's content script and relays its
 * results/progress/completion back to Kinetic. Safety stops pause the site locally too.
 */
import type { PollResponse, Site, TaskPayload, WorkerMessage, Pacing } from '../../server/src/companion/protocol.ts';
import { EXTENSION_SITES } from '../../server/src/companion/protocol.ts';
import { ApiError, kinetic } from './lib/api.ts';
import { activeSitePauses, getCurrent, getLocal, setCurrent, setLocal, type HeartbeatState, type LimitRow } from './lib/storage.ts';
import { anyPageOnSite, pageFor } from './sites/pages.ts';

const TICK = 'kinetic-tick';
const SOON = 'kinetic-soon';
const STALE_MS = 45 * 60_000;
const VERSION = chrome.runtime.getManifest().version;

const SITE_HOSTS: Record<string, string[]> = {
  linkedin: ['www.linkedin.com', 'linkedin.com'],
  instagram: ['www.instagram.com', 'instagram.com'],
  x: ['x.com', 'twitter.com', 'mobile.x.com'],
  facebook: ['www.facebook.com', 'facebook.com', 'web.facebook.com'],
  whatsapp: ['web.whatsapp.com'],
};

// ---- lifecycle --------------------------------------------------------------------

async function ensureAlarm() {
  await chrome.alarms.create(TICK, { periodInMinutes: 0.5 });
}
chrome.runtime.onInstalled.addListener((d) => {
  void ensureAlarm();
  void refreshBadge();
  if (d.reason === 'install') void chrome.runtime.openOptionsPage();
});
chrome.runtime.onStartup.addListener(() => { void ensureAlarm(); void refreshBadge(); });

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === TICK || a.name === SOON) void tick();
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const s = await getLocal();
  const tabs = { ...(s.tabs ?? {}) };
  let changed = false;
  for (const [site, id] of Object.entries(tabs)) if (id === tabId) { delete tabs[site as Site]; changed = true; }
  if (changed) await setLocal({ tabs });
  const cur = await getCurrent();
  // The server's lease expires and the task is retried later.
  if (cur?.tabId === tabId) { await setCurrent(null); void refreshBadge(); }
});

// ---- heartbeat + poll ---------------------------------------------------------------

let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const s = await getLocal();
    if (!s.pairing?.token) { await refreshBadge(); return; }
    const hb = await heartbeat();
    if (!hb || hb.error) return;
    if (s.paused || hb.pausedAll || hb.devicePaused) return;
    const cur = await getCurrent();
    if (cur && Date.now() - cur.startedAt < STALE_MS) {
      // Still running? If the tab's content script lost it (reload/crash), free the slot.
      const alive = await chrome.tabs.sendMessage<{ busy?: boolean }>(cur.tabId, { type: 'kinetic:ping' }).catch(() => null);
      if (alive?.busy) return;
      if (Date.now() - cur.startedAt < 60_000) return; // just dispatched
    }
    if (cur) await setCurrent(null);
    await pollAndRun();
  } catch (e) {
    console.warn('[kinetic] tick failed', e);
  } finally {
    ticking = false;
    await refreshBadge();
  }
}

async function heartbeat(): Promise<HeartbeatState | null> {
  const s = await getLocal();
  const cur = await getCurrent();
  try {
    const r = await kinetic<{ paused_all: boolean; device_paused: boolean; site_pauses: Record<string, string>; pacing: Pacing; server_time: string; limits: LimitRow[] }>(
      '/api/companion/heartbeat',
      { version: VERSION, paused: !!s.paused, current_task_id: cur?.id ?? null, user_agent: navigator.userAgent, accounts: s.accounts ?? {} },
    );
    const hb: HeartbeatState = { at: new Date().toISOString(), pausedAll: !!r.paused_all, devicePaused: !!r.device_paused, sitePauses: (r.site_pauses ?? {}) as HeartbeatState['sitePauses'], limits: r.limits ?? [] };
    await setLocal({ heartbeat: hb });
    return hb;
  } catch (e) {
    const msg = e instanceof ApiError && e.status === 401 ? 'This browser was unpaired in Kinetic — pair it again in the options.' : (e as Error).message;
    const hb: HeartbeatState = { ...(s.heartbeat ?? { pausedAll: false, devicePaused: false, sitePauses: {}, limits: [] }), at: new Date().toISOString(), error: msg };
    await setLocal({ heartbeat: hb });
    return hb;
  }
}

async function pollAndRun() {
  const s = await getLocal();
  const paused = new Set(activeSitePauses(s));
  const sites = EXTENSION_SITES.filter((x) => !paused.has(x));
  if (!sites.length) return;
  const r = await kinetic<PollResponse>('/api/companion/poll', { sites });
  if (!r.task) {
    if (r.waitSeconds && r.waitSeconds < 30) await chrome.alarms.create(SOON, { when: Date.now() + Math.max(1, r.waitSeconds) * 1000 });
    return;
  }
  await dispatch(r.task);
}

async function dispatch(task: TaskPayload) {
  let tabId: number;
  try {
    // WhatsApp opens the chat with the message prefilled (?text=), so it is rendered before the page.
    if (task.site === 'whatsapp' && typeof task.params.text !== 'string') {
      const r = await kinetic<{ text: string }>(`/api/companion/tasks/${task.id}/render`, { profile: { fullName: task.target.name ?? '' } });
      task.params = { ...task.params, text: r.text ?? '' };
    }
    tabId = await ensureTab(task);
    await ensureContentScript(tabId, task.site);
  } catch (e) {
    await kinetic(`/api/companion/tasks/${task.id}/complete`, { status: 'failed', error: `Could not start on ${task.site}: ${(e as Error).message}` }).catch(() => {});
    return;
  }
  await setCurrent({ id: task.id, kind: task.kind, site: task.site, tabId, startedAt: Date.now(), label: task.kind });
  const ack = await chrome.tabs.sendMessage<{ accepted: boolean; reason?: string }>(tabId, { type: 'kinetic:run', task }).catch((e: Error) => ({ accepted: false, reason: e.message }));
  if (!ack?.accepted) {
    await setCurrent(null);
    await kinetic(`/api/companion/tasks/${task.id}/complete`, { status: 'failed', error: `The ${task.site} page did not accept the task (${ack?.reason ?? 'no response'})` }).catch(() => {});
  }
}

// ---- tabs ---------------------------------------------------------------------------

function onSite(url: string | undefined, site: Site): boolean {
  try { return !!url && SITE_HOSTS[site]!.includes(new URL(url).hostname); } catch { return false; }
}

function waitForLoad(tabId: number, timeoutMs = 45_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); reject(new Error('page load timed out')); }, timeoutMs);
    const listener = (id: number, change: { status?: string }) => {
      if (id !== tabId || change.status !== 'complete') return;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

/** One background tab per site, owned by the extension (never the user's own tabs). */
async function ensureTab(task: TaskPayload): Promise<number> {
  const s = await getLocal();
  const url = pageFor(task);
  const anyPage = anyPageOnSite(task);
  const known = s.tabs?.[task.site];
  let tab = known != null ? await chrome.tabs.get(known).catch(() => null) : null;
  if (tab && !onSite(tab.url ?? tab.pendingUrl, task.site)) tab = null;
  if (!tab) {
    tab = await chrome.tabs.create({ url, active: false, pinned: true });
    await setLocal({ tabs: { ...(s.tabs ?? {}), [task.site]: tab.id! } });
    await waitForLoad(tab.id!);
  } else if (!(anyPage && onSite(tab.url, task.site))) {
    // Exact pages are always (re)loaded so the page's own API calls are captured fresh.
    await chrome.tabs.update(tab.id!, { url });
    await waitForLoad(tab.id!);
  }
  await new Promise((r) => setTimeout(r, 1200 + Math.random() * 1500));
  return tab.id!;
}

async function ensureContentScript(tabId: number, site: Site) {
  for (let i = 0; i < 3; i++) {
    const pong = await chrome.tabs.sendMessage<{ ok?: boolean; site?: string }>(tabId, { type: 'kinetic:ping' }).catch(() => null);
    if (pong?.ok) return;
    if (i === 0) {
      // Tabs opened before the extension was installed/updated have no content script yet.
      await chrome.scripting.executeScript({ target: { tabId }, files: ['capture.js'], world: 'MAIN' }).catch(() => {});
      await chrome.scripting.executeScript({ target: { tabId }, files: [`sites/${site}.js`] }).catch(() => {});
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  throw new Error('content script not responding');
}

// ---- messages from content scripts, popup and options --------------------------------

type UiMessage = { type: 'kinetic:tick' } | { type: 'kinetic:pause'; paused: boolean } | { type: 'kinetic:status' } | { type: 'kinetic:paired' };

chrome.runtime.onMessage.addListener((msg: WorkerMessage | UiMessage, sender, sendResponse) => {
  handle(msg, sender).then((data) => sendResponse({ ok: true, data }), (e: Error) => sendResponse({ ok: false, error: e.message }));
  return true;
});

async function handle(msg: WorkerMessage | UiMessage, sender: chrome.runtime.MessageSender): Promise<unknown> {
  switch (msg.type) {
    case 'kinetic:results':
      return kinetic(`/api/companion/tasks/${msg.taskId}/results`, msg.batch);
    case 'kinetic:progress': {
      const cur = await getCurrent();
      if (cur?.id === msg.taskId) await setCurrent({ ...cur, message: msg.message, done: msg.done, total: msg.total });
      return kinetic(`/api/companion/tasks/${msg.taskId}/progress`, { message: msg.message, done: msg.done, total: msg.total, cursor: msg.cursor });
    }
    case 'kinetic:render':
      return kinetic(`/api/companion/tasks/${msg.taskId}/render`, msg.body);
    case 'kinetic:complete': {
      const r = await kinetic(`/api/companion/tasks/${msg.taskId}/complete`, msg.body);
      const cur = await getCurrent();
      const site = cur?.site;
      if (cur?.id === msg.taskId) await setCurrent(null);
      const s = await getLocal();
      await setLocal({
        lastTask: { id: msg.taskId, kind: cur?.kind ?? '', status: msg.body.status, at: new Date().toISOString(), error: msg.body.error },
        ...(site && msg.body.status !== 'failed' ? { accounts: { ...(s.accounts ?? {}), [site]: true } } : {}),
      });
      // Next task soon (the server spaces actions out with waitSeconds).
      setTimeout(() => void tick(), 2500);
      return r;
    }
    case 'kinetic:safety': {
      const cur = await getCurrent();
      const site = (cur?.id === msg.taskId ? cur.site : siteOf(sender.tab?.url)) ?? 'linkedin';
      let until = new Date(Date.now() + 6 * 3_600_000).toISOString();
      try {
        const r = await kinetic<{ paused_until?: string }>(`/api/companion/tasks/${msg.taskId}/error`, msg.body);
        if (r?.paused_until) until = r.paused_until;
      } catch { /* still pause locally */ }
      const s = await getLocal();
      await setLocal({
        sitePauses: { ...(s.sitePauses ?? {}), [site]: until },
        lastTask: { id: msg.taskId, kind: cur?.kind ?? '', status: 'stopped', at: new Date().toISOString(), error: msg.body.message },
        ...(msg.body.kind === 'logged_out' ? { accounts: { ...(s.accounts ?? {}), [site]: false } } : {}),
      });
      if (cur?.id === msg.taskId) await setCurrent(null);
      await chrome.notifications.create(`kinetic-safety-${Date.now()}`, {
        type: 'basic', iconUrl: 'icons/128.png', priority: 2,
        title: `Kinetic paused ${site}`,
        message: `${msg.body.message ?? msg.body.kind} Automations on ${site} are paused until ${new Date(until).toLocaleString()}.`,
      }).catch(() => '');
      await refreshBadge();
      return { paused_until: until };
    }
    case 'kinetic:captured':
      return null;
    case 'kinetic:tick':
      void tick();
      return null;
    case 'kinetic:paired':
      await ensureAlarm();
      void tick();
      return null;
    case 'kinetic:pause': {
      await setLocal({ paused: msg.paused });
      if (msg.paused) {
        const cur = await getCurrent();
        if (cur) await chrome.tabs.sendMessage(cur.tabId, { type: 'kinetic:abort', taskId: cur.id }).catch(() => {});
      } else {
        // Resuming clears local safety stops; server-side pauses still apply.
        await setLocal({ sitePauses: {} });
        void tick();
      }
      await refreshBadge();
      return null;
    }
    case 'kinetic:status':
      return { local: await getLocal(), current: await getCurrent() };
  }
}

function siteOf(url: string | undefined): Site | null {
  for (const site of EXTENSION_SITES) if (onSite(url, site)) return site;
  return null;
}

async function refreshBadge() {
  const s = await getLocal();
  const cur = await getCurrent();
  let text = '';
  let color = '#71717a';
  let title = 'Kinetic Companion';
  if (!s.pairing?.token) { text = 'off'; title += ' — not paired'; }
  else if (s.heartbeat?.error) { text = '!'; color = '#dc2626'; title += ` — ${s.heartbeat.error}`; }
  else if (s.paused || s.heartbeat?.pausedAll || s.heartbeat?.devicePaused) { text = '||'; title += ' — paused'; }
  else if (activeSitePauses(s).length) { text = '!'; color = '#d97706'; title += ` — paused on ${activeSitePauses(s).join(', ')}`; }
  else if (cur) { text = '•'; color = '#16a34a'; title += ` — running ${cur.kind}`; }
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setTitle({ title });
}
