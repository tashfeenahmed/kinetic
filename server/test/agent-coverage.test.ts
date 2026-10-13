import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { makeEnv } from './helpers.ts';
import { routeDocs } from '../src/http.ts';
import { classifyRoute } from '../src/agent/policy.ts';

/** Routes the agent may call but doesn't need a playbook for (docs, logos, file downloads). */
const NO_SKILL_NEEDED = new Set(['GET /api/openapi.json', 'GET /api/reference', 'GET /api/gtm/icon/:domain']);

it('every API route the agent may call is described in a skill', async () => {
  const env = await makeEnv();
  try {
    const dir = join(import.meta.dirname, '../src/agent/skills');
    const skills = readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
    const missing = routeDocs
      .filter((r) => !r.public && r.url.startsWith('/api/'))
      .filter((r) => classifyRoute(r.method, r.url.replace(/:[^/]+/g, '1')).kind !== 'deny')
      .filter((r) => !NO_SKILL_NEEDED.has(`${r.method} ${r.url}`))
      .filter((r) => {
        // `/api/x/:id/y` matches `/api/x/{id}/y`, `/api/x/12/y` or `/api/x/:id/y` in a skill.
        const re = new RegExp(r.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:[A-Za-z_]+/g, '[^/\\s"`?]+') + '(?![\\w/-])');
        return !re.test(skills);
      })
      .map((r) => `${r.method} ${r.url}`);
    expect(missing, 'Add these routes to an agent skill in src/agent/skills (or deny them in policy.ts)').toEqual([]);
  } finally {
    await env.close();
  }
});
