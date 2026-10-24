/**
 * SQL LIKE helpers.
 *
 * A search box that passes user text straight into `LIKE '%<text>%'` treats `%`
 * and `_` in the query as wildcards: searching for `100%` matches every row
 * that merely *starts* with "100", and `a_b` matches `axb`. Escape both (and
 * the escape character itself) and pair every use with `LIKE ? ESCAPE '\'`.
 */

/** The escape clause to append to every LIKE that uses {@link contains}. */
export const LIKE_ESCAPE = `ESCAPE '\\'`;

/** A search word made safe for a `LIKE … ESCAPE '\'` pattern, wrapped in `%`. */
export function contains(word: string): string {
  return `%${word.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}
