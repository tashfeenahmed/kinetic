import { describe, it, expect } from 'vitest';
import { rampTarget } from '../src/engine/warmup.ts';

const sender = (startedAt: string) => ({ warmup_started_at: startedAt, warmup_daily_limit: 20 });
const at = (iso: string) => new Date(iso);
const TZ = 'Europe/Dublin';

describe('warmup ramp', () => {
  it('steps up at local midnight, not at the hour warmup was switched on', () => {
    const s = sender('2026-10-13T09:30:00Z'); // 10:30 Dublin
    expect(rampTarget(s, at('2026-10-13T19:00:00Z'), TZ)).toBe(2);
    expect(rampTarget(s, at('2026-10-13T23:30:00Z'), TZ)).toBe(4); // 00:30 Dublin next day
    expect(rampTarget(s, at('2026-10-14T19:00:00Z'), TZ)).toBe(4); // same all day, no 09:30 jump
    expect(rampTarget(s, at('2026-10-15T07:00:00Z'), TZ)).toBe(6);
  });

  it('a late-evening start counts from the next day', () => {
    const s = sender('2026-10-12T18:58:24Z'); // 19:58 Dublin, window closes at 20:00
    expect(rampTarget(s, at('2026-10-13T08:00:00Z'), TZ)).toBe(2);
    expect(rampTarget(s, at('2026-10-14T08:00:00Z'), TZ)).toBe(4);
  });

  it('caps at the daily limit', () => {
    expect(rampTarget(sender('2026-09-01T09:00:00Z'), at('2026-10-13T09:00:00Z'), TZ)).toBe(20);
  });
});
