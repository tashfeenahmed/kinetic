import { afterEach, describe, expect, it } from 'vitest';
import { Db } from '../src/db/db.ts';
import { Settings } from '../src/gtm/settings.ts';
import { setHttpFetch } from '../src/gtm/lib/http.ts';
import { createDoc, TEMPLATES } from '../src/knowledge/store.ts';
import { fitScore, NO_ICP, parseFit, rowFacts } from '../src/gtm/providers/fit.ts';
import { enrichKind } from '../src/gtm/providers/catalog.ts';
import { FINGERPRINTS, signalKind } from '../src/gtm/providers/signals.ts';
import { auditPage, blockedAiCrawlers, websiteAudit } from '../src/gtm/providers/websiteAudit.ts';
import { Store } from '../src/gtm/engine/store.ts';
import { Bus } from '../src/gtm/events.ts';
import { Engine } from '../src/gtm/engine/runner.ts';
import { render } from '../src/gtm/lib/template.ts';
import { gtmTestSetup, workspace } from './gtm-helpers.ts';

gtmTestSetup();
afterEach(() => setHttpFetch((...a) => globalThis.fetch(...a)));

describe('Fit score', () => {
  function setup(icp?: string) {
    const db = new Db(':memory:');
    const settings = new Settings(db);
    settings.set('OPENROUTER_API_KEY', 'or-test');
    const ws = workspace(db);
    if (icp != null) createDoc(db, ws, { title: 'Ideal customer profile', content: icp });
    createDoc(db, ws, { title: 'Tone of voice', content: 'Friendly. Never mention this in scoring.' });
    return { settings, ws };
  }
  const row = {
    Company: 'Bean Bar', 'Company domain': 'beanbar.ie', Industry: 'Coffee shops', Employees: { value: 12, data: { employees: 12, location: 'Dublin, Ireland', html: '<huge>' } },
    'Work email': 'ann@beanbar.ie', 'LinkedIn URL': 'https://linkedin.com/company/beanbar',
    Research: { value: { summary: 'Three cafés in Dublin, opening a fourth.' }, data: { summary: 'Three cafés in Dublin, opening a fourth.', icebreaker: 'x' } },
  };

  it('scores the row against the ICP with one deterministic call', async () => {
    const { settings, ws } = setup('## Firmographics\n\n- **Industries:** cafés, restaurants\n- **Geographies:** Ireland\n');
    let body: any;
    setHttpFetch((async (_u: any, init: any) => {
      body = JSON.parse(init.body);
      return Response.json({ choices: [{ message: { content: '```json\n{"score": 86, "reason": "Irish café group expanding, matches industry and geography."}\n```' } }], usage: { prompt_tokens: 300, completion_tokens: 20 } });
    }) as typeof fetch);
    const hit = await fitScore({ companyName: 'Bean Bar', domain: 'beanbar.ie' }, { settings, workspaceId: ws, row, log: () => {} });
    expect(hit).toMatchObject({ value: 86, confidence: 'strong', data: { score: 86, tier: 'strong', reason: 'Irish café group expanding, matches industry and geography.', icp_docs: ['Ideal customer profile'] } });
    expect(body.temperature).toBe(0);
    const prompt = body.messages[1].content as string;
    expect(prompt).toContain('cafés, restaurants');
    expect(prompt).not.toContain('Tone of voice'); // only ICP / persona docs
    expect(prompt).toContain('Industry: Coffee shops');
    expect(prompt).toContain('location: Dublin, Ireland');
    expect(prompt).toContain('opening a fourth');
    expect(prompt).not.toContain('ann@beanbar.ie');
    expect(prompt).not.toContain('linkedin.com');
    expect(prompt).not.toContain('<huge>');
  });

  it('asks for an ICP instead of guessing when there is none (or only the starter template)', async () => {
    let calls = 0;
    setHttpFetch((async () => { calls++; return Response.json({}); }) as typeof fetch);
    for (const icp of [undefined, TEMPLATES.find((t) => t.key === 'icp')!.content]) {
      const { settings, ws } = setup(icp);
      await expect(fitScore({ companyName: 'Bean Bar' }, { settings, workspaceId: ws, row, log: () => {} })).rejects.toThrow(NO_ICP);
    }
    expect(calls).toBe(0);
  });

  it('runs as a table column: reads the row (not actions), outputs work as variables', async () => {
    const { settings, ws } = setup('- **Industries:** cafés');
    const store = new Store(settings.db);
    const engine = new Engine(store, settings, new Bus());
    const t = store.createTable(ws, 'Leads');
    for (const name of ['Company', 'Industry']) store.createColumn(t, { name, type: 'text' });
    store.createColumn(t, { name: 'Push', type: 'action', config: { kind: 'webhook' } });
    const fit = store.createColumn(t, { name: 'Fit score', type: 'enrich', config: { kind: 'fit_score', inputs: { companyName: '{{Company}}' } } });
    let prompt = '';
    setHttpFetch((async (_u: any, init: any) => {
      prompt = JSON.parse(init.body).messages[1].content;
      return Response.json({ choices: [{ message: { content: '{"score": 31, "reason": "Industry is steel, not cafés."}' } }] });
    }) as typeof fetch);
    const row = { Company: 'Acme Steel', Industry: 'Steel', Push: { value: 'sent: secret-action-output' }, 'Fit score': null };
    const out = await engine.compute(store.column(fit), row, { tableId: t, rowId: 1, columnId: fit, type: 'enrich' });
    expect(prompt).toContain('Industry: Steel');
    expect(prompt).not.toContain('secret-action-output');
    const cell = { ...row, 'Fit score': out.value };
    expect(render('{{Fit score}} {{Fit score.tier}}: {{Fit score.reason}}', cell)).toBe('31 poor: Industry is steel, not cafés.');
  });

  it('parses and tiers answers, truncates facts, and is in the catalog', () => {
    expect(parseFit('Sure! {"score": "55", "reason": "Right size, wrong country."}')).toEqual({ score: 55, reason: 'Right size, wrong country.' });
    expect(parseFit('{"score": 140}')?.score).toBe(100);
    expect(parseFit('no json')).toBeNull();
    const facts = rowFacts({ companyName: 'X' }, Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`Field ${i}`, 'y'.repeat(500 + i)])));
    expect(facts.length).toBeLessThanOrEqual(2000);
    expect(facts.split('\n')[1].length).toBeLessThan(320);
    expect(enrichKind('fit_score').steps[0].cost).toContain('free');
  });
});

describe('Website audit signal', () => {
  const HTML = `<!doctype html><html><head><title>Bean Bar</title>
    <script src="https://connect.facebook.net/en_US/fbevents.js"></script>
    <script async src="https://analytics.tiktok.com/i18n/pixel/events.js"></script>
    <script type="application/ld+json">{"@context":"https://schema.org","@type":"CafeOrCoffeeShop","name":"Bean Bar"}</script>
    </head><body><nav><a href="/menu">Menu</a></nav><p>Great coffee made by hand.</p>
    <footer><p>&copy; 2019 Bean Bar Ltd. All rights reserved.</p><p>Website by <a href="https://pixelstudio.ie/?ref=beanbar">Pixel Studio</a> · Powered by WordPress</p></footer>
    </body></html>`;
  const ROBOTS = 'User-agent: *\nDisallow: /wp-admin/\n\nUser-agent: GPTBot\nUser-agent: CCBot\nDisallow: /\n\nUser-agent: ClaudeBot\nDisallow: /\nAllow: /\n';

  function serve(pages: Record<string, string>, seen: string[] = []) {
    setHttpFetch((async (u: any) => {
      const url = String(u);
      seen.push(url);
      const body = pages[url];
      return body == null ? new Response('missing', { status: 404 }) : new Response(body, { headers: { 'content-type': 'text/html' } });
    }) as typeof fetch);
  }
  const ctx = (prev?: unknown) => ({ settings: new Settings(new Db(':memory:')), log: () => {}, prev });

  it('turns the homepage and robots.txt into first-line findings', async () => {
    const seen: string[] = [];
    serve({ 'https://beanbar.ie/': HTML, 'https://beanbar.ie/robots.txt': ROBOTS }, seen);
    const hit = await websiteAudit({ domain: 'www.beanbar.ie' }, ctx(), FINGERPRINTS, { now: new Date('2026-10-13') });
    const d = hit!.data as any;
    expect(d.agency).toEqual({ name: 'Pixel Studio', url: 'https://pixelstudio.ie/?ref=beanbar' });
    expect(d.booking).toEqual([]);
    expect(d.ads).toEqual(['Meta Pixel', 'TikTok Pixel']);
    expect(d).toMatchObject({ copyrightYear: 2019, staleCopyright: true, https: true, mobileViewport: false, metaDescription: false, localBusinessSchema: true, aiCrawlersBlocked: ['GPTBot', 'CCBot'] });
    expect(hit!.value).toBe('Site by Pixel Studio (pixelstudio.ie); no online booking; running ads (Meta Pixel, TikTok Pixel); footer still says © 2019; no mobile viewport, no meta description; blocks AI crawlers (GPTBot, CCBot)');
    expect(seen).toEqual(['https://beanbar.ie/', 'https://beanbar.ie/robots.txt']);
    expect(signalKind('website_audit').requires).toEqual([]);
  });

  it('flags changes since the last run (new agency, ads, booking) and plain-HTTP sites', async () => {
    const v2 = HTML.replace('Pixel Studio', 'Bright Web').replace('<script src="https://connect.facebook.net/en_US/fbevents.js"></script>', '<script src="https://www.googleadservices.com/pagead/conversion.js"></script><a href="https://www.fresha.com/book-now/bean-bar">Book</a>');
    serve({ 'https://beanbar.ie/': HTML, 'https://beanbar.ie/robots.txt': '' });
    const first = await websiteAudit({ domain: 'beanbar.ie' }, ctx(), FINGERPRINTS);
    serve({ 'https://beanbar.ie/': v2 });
    const second = await websiteAudit({ domain: 'beanbar.ie' }, ctx(first), FINGERPRINTS);
    expect(second!.value).not.toBe(first!.value);
    expect((second!.data as any).changes).toEqual(['started Google Ads ads', 'stopped Meta Pixel ads', 'added booking (Fresha)', 'changed agency: Pixel Studio → Bright Web']);

    serve({ 'http://old.ie/': '<html><head><meta name="viewport" content="width=device-width"><meta name="description" content="Plumbers"></head><body>© 2026</body></html>' });
    const plain = await websiteAudit({ domain: 'old.ie' }, ctx(), FINGERPRINTS, { now: new Date('2026-10-13') });
    expect(plain!.data).toMatchObject({ https: false, staleCopyright: false, agency: null });
    expect(plain!.value).toBe('No online booking; no ad pixels; no HTTPS, no LocalBusiness schema');

    serve({});
    expect(await websiteAudit({ domain: 'gone.ie' }, ctx(), FINGERPRINTS)).toMatchObject({ value: null, data: { note: 'gone.ie did not load (HTTP 404)' } });
  });

  it('detects booking tools, slow responses and robots rules', () => {
    for (const [html, tool] of [
      ['<a href="https://app.acuityscheduling.com/schedule.php?owner=1">Book</a>', 'Acuity Scheduling'],
      ['<iframe src="https://www.opentable.ie/widget/reservation"></iframe>', 'OpenTable'],
      ['<a href="https://cal.com/bean/30min">Call</a>', 'Cal.com'],
      ['<a href="https://calendar.app.google/abc123">Book</a>', 'Google appointment booking'],
      ['<script src="https://widget.treatwell.co.uk/x.js"></script>', 'Treatwell'],
    ]) expect(auditPage({ url: 'https://x.ie/', html, headers: {} }, '', 10, FINGERPRINTS).booking).toEqual([tool]);
    expect(auditPage({ url: 'https://x.ie/', html: '<a href="https://local.com/x">', headers: {} }, '', 10, FINGERPRINTS).booking).toEqual([]);
    expect(auditPage({ url: 'https://x.ie/', html: '', headers: {} }, '', 4200, FINGERPRINTS).slow).toBe(true);
    expect(blockedAiCrawlers('User-agent: *\nDisallow: /')).toEqual(['GPTBot', 'ClaudeBot', 'PerplexityBot', 'Google-Extended', 'CCBot']);
    expect(blockedAiCrawlers('User-agent: *\nDisallow: /\n\nUser-agent: GPTBot\nAllow: /')).not.toContain('GPTBot');
  });
});
