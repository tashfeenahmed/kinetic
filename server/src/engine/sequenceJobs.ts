import type { Ctx } from '../context.ts';
import { evaluateAbTests } from './abtest.ts';
import { resolvePendingProviders } from './emailProvider.ts';

/** Background jobs for A/B auto-winners and recipient-provider (MX) lookups. */
export function sequenceJobs(k: number) {
  return [
    { name: 'ab-tests', everyMs: 5 * 60_000 * k, run: (c: Ctx) => evaluateAbTests(c) },
    { name: 'email-providers', everyMs: 60_000 * k, run: (c: Ctx) => resolvePendingProviders(c) },
  ];
}
