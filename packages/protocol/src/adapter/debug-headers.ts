/**
 * Never forwarded, debug or not: `authorization` binds a token the worker must
 * not see (ADR 0025), and a site's cookies are the site's.
 */
const NEVER_FORWARDED: ReadonlySet<string> = new Set(['authorization', 'proxy-authorization', 'cookie']);

/** Bounds on the record: adapter-authored input the request record would otherwise carry whole. */
export const MAX_DEBUG_HEADERS = 64;

export const MAX_DEBUG_HEADER_LENGTH = 2048;

/**
 * Every request header but the credentials, each within bounds, in arrival order.
 * For the request record alone, under `DEBUG_LOG_RAW_PAYLOAD`: nothing that
 * verifies a request reads it, so forwarding more can change no verdict.
 */
export function debugHeadersOf(entries: Iterable<[string, unknown]>): Record<string, string> {
  const out: Record<string, string> = {};
  let kept = 0;
  for (const [rawName, value] of entries) {
    if (kept === MAX_DEBUG_HEADERS) break;

    const name = rawName.toLowerCase();
    if (NEVER_FORWARDED.has(name) || typeof value !== 'string' || value.length > MAX_DEBUG_HEADER_LENGTH) {
      continue;
    }

    out[name] = value;
    kept += 1;
  }

  return out;
}
