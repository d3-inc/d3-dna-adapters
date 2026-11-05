import { NEVER_FORWARDED_HEADERS } from './forwarding.constants';

/** Bounds on the record: adapter-authored input the request record would otherwise carry whole. */
export const MAX_DEBUG_HEADERS = 64;

export const MAX_DEBUG_HEADER_LENGTH = 2048;

/**
 * Every request header but the never-forwarded and the site's exclusions, each
 * within bounds, in arrival order.
 * For the request record alone, under `DEBUG_LOG_RAW_PAYLOAD`: nothing that
 * verifies a request reads it, so forwarding more can change no verdict.
 */
export function debugHeadersOf(
  entries: Iterable<[string, unknown]>,
  excluded: readonly string[] = []
): Record<string, string> {
  const keptBack = new Set(excluded);
  const out: Record<string, string> = {};
  let kept = 0;
  for (const [rawName, value] of entries) {
    if (kept === MAX_DEBUG_HEADERS) break;

    const name = rawName.toLowerCase();
    if (NEVER_FORWARDED_HEADERS.has(name) || keptBack.has(name)) continue;

    if (typeof value !== 'string' || value.length > MAX_DEBUG_HEADER_LENGTH) continue;

    out[name] = value;
    kept += 1;
  }

  return out;
}
