import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeEnv, type TestEnv } from './helpers.ts';

let env: TestEnv;
beforeEach(async () => { env = await makeEnv(); });
afterEach(() => env.close());

describe('site-wide headers', () => {
  it('no other site may frame the app', async () => {
    const r = await env.app.inject({ method: 'GET', url: '/healthz' });
    expect(r.headers['x-frame-options']).toBe('SAMEORIGIN');
    const api = await env.app.inject({ method: 'GET', url: '/api/auth/me' });
    expect(api.headers['x-frame-options']).toBe('SAMEORIGIN');
  });

  it('a content security policy allows only the app\'s own scripts', async () => {
    for (const url of ['/healthz', '/api/auth/me', '/u/missing']) {
      const csp = (await env.app.inject({ method: 'GET', url })).headers['content-security-policy'] as string;
      expect(csp).toContain("script-src 'self'");
      expect(csp).toContain("frame-ancestors 'self'");
      expect(csp).toContain("object-src 'none'");
    }
  });

  it('the API reference page keeps its CDN viewer', async () => {
    const r = await env.app.inject({ method: 'GET', url: '/api/reference' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-security-policy']).toBeUndefined();
  });

  it('robots.txt keeps the whole app out of search engines', async () => {
    const r = await env.app.inject({ method: 'GET', url: '/robots.txt' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toMatch(/^text\/plain/);
    expect(r.body).toBe('User-agent: *\nDisallow: /\n');
  });
});
