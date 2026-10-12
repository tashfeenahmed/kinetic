import type { TestEnv } from './helpers.ts';

/** Pairs a fake extension and returns a caller that uses its token. */
export async function pairExtension(env: TestEnv, name = 'Test Chrome') {
  const code = (await env.api('POST', '/api/companion/pairing-code')).body.data.code as string;
  const res = await env.app.inject({ method: 'POST', url: '/api/companion/pair', payload: { code, name, version: '0.1.0' } });
  const { token, device_id } = res.json() as { token: string; device_id: number };
  const ext = async (method: string, url: string, body?: unknown) => {
    const r = await env.app.inject({ method: method as any, url, headers: { authorization: `Bearer ${token}` }, payload: body as any });
    let parsed: any = null;
    try { parsed = r.json(); } catch { parsed = r.body; }
    return { status: r.statusCode, body: parsed, headers: r.headers };
  };
  return { token, deviceId: device_id, ext };
}

/** Working hours always open, tiny pacing gaps, generous hourly cap — so tests control limits explicitly. */
export async function openSettings(env: TestEnv, extra: Record<string, unknown> = {}) {
  return env.api('PUT', '/api/automations/settings', {
    working_hours: { enabled: false }, delays: { action_min_sec: 5, action_max_sec: 5, page_min_sec: 1, page_max_sec: 1 }, max_actions_per_hour: 200, ...extra,
  });
}

export const advance = (env: TestEnv, ms: number) => { env.clock.now = new Date(env.clock.now.getTime() + ms); };
