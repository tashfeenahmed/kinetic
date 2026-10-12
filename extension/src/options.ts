/** Options page: Kinetic URL, pairing (code or API token), unpair, status. */
import { kinetic, normalizeServerUrl, originPattern } from './lib/api.ts';
import { clearPairing, getLocal, setLocal } from './lib/storage.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const url = $<HTMLInputElement>('url');
const code = $<HTMLInputElement>('code');
const token = $<HTMLInputElement>('token');

function message(id: string, text: string, tone: 'ok' | 'error' | '' = '') {
  const el = $(id);
  el.textContent = text;
  el.className = `msg ${tone}`;
}

async function defaultUrl(): Promise<string> {
  try {
    const r = await fetch(chrome.runtime.getURL('kinetic.json'));
    if (r.ok) return String((await r.json()).url ?? '');
  } catch { /* not bundled */ }
  return '';
}

async function render() {
  const s = await getLocal();
  const p = s.pairing;
  $('paired').classList.toggle('hidden', !p?.token);
  $('pair').classList.toggle('hidden', !!p?.token);
  const state = $('state');
  const hbErr = s.heartbeat?.error;
  const tone = !p?.token ? '' : hbErr ? 'red' : s.paused ? 'amber' : 'green';
  state.innerHTML = `<span class="dot ${tone}"></span><span>${!p?.token ? 'Not paired' : hbErr ? 'Problem' : s.paused ? 'Paused' : 'Connected'}</span>`;
  if (p?.token) {
    $('ws').textContent = p.workspaceName ? `Workspace: ${p.workspaceName}` : 'Paired';
    $('server').textContent = `${p.serverUrl}${p.deviceId ? ` · device #${p.deviceId}` : ''}`;
    if (hbErr) message('paired-msg', hbErr, 'error');
  } else if (!url.value) {
    url.value = (await defaultUrl()) || p?.serverUrl || '';
  }
}

/** Host permission for the Kinetic server (so requests bypass CORS); must run in a click handler. */
async function allowServer(server: string): Promise<void> {
  const origins = [originPattern(server)];
  if (await chrome.permissions.contains({ origins })) return;
  const ok = await chrome.permissions.request({ origins });
  if (!ok) throw new Error('Permission to reach your Kinetic server was declined.');
}

async function pairWithCode() {
  const server = normalizeServerUrl(url.value);
  const c = code.value.trim().toUpperCase();
  if (!server || !c) return message('pair-msg', 'Enter your Kinetic URL and the pairing code.', 'error');
  try {
    await allowServer(server);
    const r = await kinetic<{ token: string; device_id: number; workspace_name: string; kinetic_url?: string }>(
      '/api/companion/pair', { code: c, name: browserName(), version: chrome.runtime.getManifest().version }, { serverUrl: server, token: null },
    );
    await setLocal({ pairing: { serverUrl: server, token: r.token, deviceId: r.device_id, workspaceName: r.workspace_name }, paused: false });
    code.value = '';
    message('pair-msg', '');
    await chrome.runtime.sendMessage({ type: 'kinetic:paired' }).catch(() => {});
    message('paired-msg', 'Paired. This browser will now pick up automations from Kinetic.', 'ok');
    await render();
  } catch (e) {
    message('pair-msg', (e as Error).message, 'error');
  }
}

async function pairWithToken() {
  const server = normalizeServerUrl(url.value);
  const t = token.value.trim();
  if (!server || !t) return message('pair-msg', 'Enter your Kinetic URL and an API token.', 'error');
  try {
    await allowServer(server);
    const r = await kinetic<{ device: { id: number }; workspace_name: string }>('/api/companion/me', undefined, { serverUrl: server, token: t });
    await setLocal({ pairing: { serverUrl: server, token: t, deviceId: r.device?.id, workspaceName: r.workspace_name }, paused: false });
    token.value = '';
    await chrome.runtime.sendMessage({ type: 'kinetic:paired' }).catch(() => {});
    message('paired-msg', 'Connected with your API token.', 'ok');
    await render();
  } catch (e) {
    message('pair-msg', (e as Error).message, 'error');
  }
}

async function unpair() {
  try { await kinetic('/api/companion/unpair', {}); } catch { /* token may already be revoked */ }
  await clearPairing();
  message('paired-msg', '');
  message('pair-msg', 'Unpaired.', 'ok');
  await render();
}

async function test() {
  try {
    const r = await kinetic<{ device: { name: string }; workspace_name: string }>('/api/companion/me');
    message('paired-msg', `OK — ${r.device?.name ?? 'this browser'} in ${r.workspace_name}.`, 'ok');
    await chrome.runtime.sendMessage({ type: 'kinetic:tick' }).catch(() => {});
  } catch (e) {
    message('paired-msg', (e as Error).message, 'error');
  }
}

function browserName(): string {
  const ua = navigator.userAgent;
  const b = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Brave/.test(ua) ? 'Brave' : 'Chrome';
  const os = /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'desktop';
  return `${b} on ${os}`;
}

$('pair-code').addEventListener('click', () => void pairWithCode());
$('pair-token').addEventListener('click', () => void pairWithToken());
$('unpair').addEventListener('click', () => void unpair());
$('test').addEventListener('click', () => void test());
code.addEventListener('keydown', (e) => { if (e.key === 'Enter') void pairWithCode(); });
token.addEventListener('keydown', (e) => { if (e.key === 'Enter') void pairWithToken(); });
chrome.storage.onChanged.addListener(() => void render());
void render();
