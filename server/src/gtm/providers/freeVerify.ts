import { smtpVerify } from '../lib/smtp.ts';
import { mxVerify } from './free.ts';
import type { Ctx, EnrichInput, Hit } from './types.ts';

/** Verify step: definitive SMTP answers stop the waterfall; catch-all/unknown fall through to paid verifiers. */
export async function smtpVerifyStep(input: EnrichInput, ctx: Ctx): Promise<Hit | null> {
  const basic = await mxVerify(input);
  if (basic?.value === 'invalid') return basic;
  const r = await smtpVerify(String(input.email), { helo: ctx.settings.get('SMTP_HELO') });
  const hit = { value: r.verdict, data: { ...r, disposableOrFree: basic?.value === 'risky' ? basic.data?.reason : undefined } };
  return r.verdict === 'valid' || r.verdict === 'invalid' ? hit : { ...hit, weak: true };
}
