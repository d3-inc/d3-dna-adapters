/**
 * Path component of a request target (strips the query string).
 *
 * Never `''`, which a target of `?x=1` would otherwise produce: the path rollup
 * reserves the empty string for the folded remainder of its top-N cap
 * (`requestLogPath5m`), so a stored `''` would be summed into that remainder
 * and then hidden from the top-paths list by the same filter that excludes it.
 */
export function pathOf(url: string): string {
  const q = url.indexOf('?');
  const path = q < 0 ? url : url.slice(0, q);
  return path === '' ? '/' : path;
}
