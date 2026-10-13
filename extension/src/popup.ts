/** Popup: current task, today's usage per limit, pause/resume, open Kinetic. */
import { activeSitePauses, getCurrent, getLocal } from './lib/storage.ts';

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const KIND_LABELS: Record<string, string> = {
  'linkedin.visit': 'Visiting a profile', 'linkedin.connect': 'Sending an invitation', 'linkedin.message': 'Sending a message',
  'linkedin.check_connections': 'Checking new connections', 'linkedin.check_inbox': 'Checking the LinkedIn inbox', 'linkedin.comment': 'Posting an approved comment',
  'whatsapp.message_sender': 'Sending a WhatsApp message',
};
const label = (kind: string) => KIND_LABELS[kind] ?? kind.replace(/^[a-z_]+\./, '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

function ago(iso?: string) {
  if (!iso) return '';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
}

async function render() {
  const s = await getLocal();
  const cur = await getCurrent();
  const paired = !!s.pairing?.token;
  $('unpaired').classList.toggle('hidden', paired);
  $('main').classList.toggle('hidden', !paired);
  const hb = s.heartbeat;
  const paused = !!s.paused || !!hb?.pausedAll || !!hb?.devicePaused;
  const sitePauses = activeSitePauses(s);
  const tone = !paired ? '' : hb?.error ? 'red' : paused || sitePauses.length ? 'amber' : 'green';
  const text = !paired ? 'Not paired' : hb?.error ? 'Problem' : paused ? 'Paused' : cur ? 'Running' : 'Ready';
  $('state').innerHTML = `<span class="dot ${tone}"></span><span>${text}</span>`;
  if (!paired) return;

  $('task').textContent = cur ? label(cur.kind) : 'Idle';
  $('task-sub').textContent = cur ? (cur.message ?? `${cur.site} · started ${ago(new Date(cur.startedAt).toISOString())}`) : s.lastTask ? `Last: ${label(s.lastTask.kind)} — ${s.lastTask.status} ${ago(s.lastTask.at)}` : '';
  const notices: string[] = [];
  if (hb?.error) notices.push(hb.error);
  if (hb?.pausedAll) notices.push('All automations are paused in Kinetic.');
  if (sitePauses.length) notices.push(`Safety stop on ${sitePauses.join(', ')}.`);
  if (s.lastTask?.error && s.lastTask.status !== 'done') notices.push(s.lastTask.error);
  $('notice').textContent = notices.join(' ');

  const rows = (hb?.limits ?? []).filter((l) => l.used_today > 0 || /linkedin\.(connect|message|visit|scrape)|whatsapp\.message/.test(l.action));
  $('limits').innerHTML = rows.length ? rows.map((l) => {
    const pct = l.daily ? Math.min(100, Math.round((l.used_today / l.daily) * 100)) : 0;
    const week = l.weekly ? ` · ${l.used_week}/${l.weekly} wk` : '';
    return `<tr><td>${esc(l.label)}<div class="bar"><i style="width:${pct}%"></i></div></td><td class="num">${l.used_today}/${l.daily}${week}</td></tr>`;
  }).join('') : '<tr><td class="sub">No activity yet today.</td></tr>';

  $('pause').textContent = s.paused ? 'Resume' : 'Pause all';
  $('seen').textContent = hb?.at ? `Synced ${ago(hb.at)}` : '';
}

$('pause').addEventListener('click', async () => {
  const s = await getLocal();
  await chrome.runtime.sendMessage({ type: 'kinetic:pause', paused: !s.paused });
  await render();
});
$('open').addEventListener('click', async () => {
  const s = await getLocal();
  if (s.pairing?.serverUrl) await chrome.tabs.create({ url: `${s.pairing.serverUrl}/automations`, active: true });
});
$('options').addEventListener('click', () => void chrome.runtime.openOptionsPage());
$('settings').addEventListener('click', (e) => { e.preventDefault(); void chrome.runtime.openOptionsPage(); });
chrome.storage.onChanged.addListener(() => void render());
void chrome.runtime.sendMessage({ type: 'kinetic:tick' }).catch(() => {});
void render();
