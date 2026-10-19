import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeEnv, type TestEnv } from './helpers.ts';
import { createLoginGuard, loginKeys } from '../src/lib/loginGuard.ts';

describe('login guard', () => {
  const DAY = 86_400_000;
  it('locks after 5 failures inside the window and frees the budget when it passes', () => {
    const g = createLoginGuard();
    const t0 = Date.now();
    for (let i = 0; i < 5; i++) expect(g.check('k', t0)).toBe(0), g.failure('k', t0);
    expect(g.check('k', t0)).toBeGreaterThan(0);
    // After the window elapses, attempts are allowed again.
    expect(g.check('k', t0 + 15 * 60_000 + 1)).toBe(0);
    expect(g.check('k', t0 + DAY)).toBe(0);
  });

  it('a success clears the budget', () => {
    const g = createLoginGuard();
    const t0 = Date.now();
    for (let i = 0; i < 4; i++) g.failure('k', t0);
    g.clear('k');
    expect(g.check('k', t0)).toBe(0);
  });

  it('the failure counter window restarts from the first failure of a new window', () => {
    const g = createLoginGuard();
    const t0 = Date.now();
    g.failure('k', t0);
    // Old entry expired: this failure opens a fresh window, not a 2-failure one.
    g.failure('k', t0 + 15 * 60_000 + 1);
    expect(g.check('k', t0 + 15 * 60_000 + 1)).toBe(0);
  });

  it('guards the account and the source address separately', () => {
    const [acct, ip] = loginKeys('Admin@X.test', '10.0.0.1');
    expect(acct).toBe('acct:admin@x.test');
    expect(ip).toBe('ip:10.0.0.1');
  });
});

describe('POST /api/auth/login rate limit', () => {
  let env: TestEnv;
  beforeEach(async () => { env = await makeEnv(); });
  afterEach(() => env.close());

  const tryLogin = (password: string) =>
    env.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@bear.test', password } });

  it('blocks the 6th wrong password in 15 minutes with a 429 and retry-after', async () => {
    for (let i = 0; i < 5; i++) {
      const r = await tryLogin('wrong');
      expect(r.statusCode).toBe(422);
    }
    const blocked = await tryLogin('wrong');
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error).toBe('too_many_attempts');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    // Even the RIGHT password is refused while locked: the budget exists to stop oracles.
    const right = await tryLogin('password123');
    expect(right.statusCode).toBe(429);
  });

  it('a good login before the cap clears nothing for other accounts', async () => {
    for (let i = 0; i < 3; i++) await tryLogin('wrong');
    const ok = await tryLogin('password123');
    expect(ok.statusCode).toBe(200);
  });
});
