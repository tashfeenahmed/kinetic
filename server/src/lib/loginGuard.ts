/**
 * A failure budget for the login endpoint.
 *
 * Without it, the login form is an unlimited password oracle: a self-hosted
 * Kinetic opened to the internet (or to a LAN) can be brute-forced one guess
 * per request, forever. This caps failed attempts per account — and per
 * source address, so one laptop behind a NAT cannot spray a whole workspace.
 *
 * State is in-memory on purpose: a restart clearing the budget is fine (the
 * attacker restarts the app to log in, the admin does not), and it keeps the
 * hot path free of writes. Same rule as the per-IP backstops in the other
 * products; a distributed loginGuard is the phase-2 note if this ever needs
 * to survive restarts.
 */
export interface LoginGuard {
  /** Seconds until `key` may try again, or 0 when the attempt may run. */
  check(key: string, nowMs: number): number;
  /** Record a failed attempt. Returns the retry-after seconds if this one locked the key. */
  failure(key: string, nowMs: number): number;
  /** A success clears the budget. */
  clear(key: string): void;
}

export interface LoginGuardOptions {
  maxFailures?: number;
  windowMs?: number;
}

export function createLoginGuard(opts: LoginGuardOptions = {}): LoginGuard {
  const max = opts.maxFailures ?? 5;
  const windowMs = opts.windowMs ?? 15 * 60_000;
  const state = new Map<string, { fails: number; first: number }>();

  return {
    check(key, nowMs) {
      const s = state.get(key);
      if (!s) return 0;
      if (nowMs - s.first > windowMs) { state.delete(key); return 0; }
      return s.fails >= max ? Math.ceil((s.first + windowMs - nowMs) / 1000) : 0;
    },
    failure(key, nowMs) {
      const s = state.get(key);
      if (!s || nowMs - s.first > windowMs) {
        state.set(key, { fails: 1, first: nowMs });
        return 0;
      }
      s.fails++;
      return s.fails >= max ? Math.ceil((s.first + windowMs - nowMs) / 1000) : 0;
    },
    clear(key) {
      state.delete(key);
    },
  };
}

/** Keys to guard an attempt under: the account and the source address. */
export function loginKeys(email: string, ip: string): string[] {
  return [`acct:${email.toLowerCase()}`, `ip:${ip}`];
}
