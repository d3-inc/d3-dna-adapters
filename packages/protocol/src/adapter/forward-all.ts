import { cookiesOf, OWN_COOKIES } from '../pay-session';
import type { RequestPayload } from '../types';
import { FORWARDED_MAX_COOKIES, FORWARDED_MAX_NAMES, NEVER_FORWARDED_HEADERS } from './forwarding.constants';

/** Per value, for a header or cookie without a cap of its own. */
export const FORWARDED_VALUE_MAX_LENGTH = 2048;

/** Names plus values, across every default-capped header and cookie, so the decision POST stays bounded. */
export const FORWARDED_MAX_TOTAL_LENGTH = 16_384;

/** What the site keeps back, by name: header names lowercase, cookie names as sent. */
export interface ForwardExclusions {
  headers: readonly string[];
  cookies: readonly string[];
}

export const NO_EXCLUSIONS: ForwardExclusions = { headers: [], cookies: [] };

export interface ForwardedRequest {
  headers: Record<string, string>;
  cookies: Record<string, string>;
  droppedHeaders: string[];
  droppedCookies: string[];
  /** A kind with more drops than a list holds: some of its names are unlisted. */
  droppedUnlisted: { headers: boolean; cookies: boolean };
}

/** A comma-separated setting as names; blanks and repeats dropped. Never capped: a name cut here would be forwarded. */
export function parseExclusionList(raw: string | undefined, { lowercase }: { lowercase: boolean }): string[] {
  const names = (raw ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
    .map((name) => (lowercase ? name.toLowerCase() : name));
  return [...new Set(names)];
}

/**
 * The exclusions as the payload echoes them: each list capped, and a kind past
 * its cap flagged, so the worker reads every unlisted name of it as withheld.
 */
export function echoedExclusions(exclude: ForwardExclusions): {
  excluded: { headers: string[]; cookies: string[] };
  overflow: { headers: boolean; cookies: boolean };
} {
  return {
    excluded: {
      headers: exclude.headers.slice(0, FORWARDED_MAX_NAMES),
      cookies: exclude.cookies.slice(0, FORWARDED_MAX_NAMES),
    },
    overflow: {
      headers: exclude.headers.length > FORWARDED_MAX_NAMES,
      cookies: exclude.cookies.length > FORWARDED_MAX_NAMES,
    },
  };
}

/**
 * What to tell a site whose exclusion list is longer than the payload echoes,
 * or undefined. Past the cap the worker reads every name of that kind the
 * request lacks as kept back, so a rule on a missing one is skipped.
 */
export function exclusionOverflowWarning(exclude: ForwardExclusions): string | undefined {
  const lines = (['headers', 'cookies'] as const)
    .filter((kind) => exclude[kind].length > FORWARDED_MAX_NAMES)
    .map(
      (kind) =>
        `DNA_EXCLUDE_${kind.toUpperCase()} lists ${exclude[kind].length} names, past the ${FORWARDED_MAX_NAMES} DNA is sent: ` +
        `it reads any ${kind === 'headers' ? 'header' : 'cookie'} a request lacks as kept back, and skips the rules that check one`
    );
  return lines.length > 0 ? lines.join('; ') : undefined;
}

/** A revision 2 payload's account of what it held back: the exclusions echoed, and each kind past its lists flagged. */
export function withheldOf(
  exclude: ForwardExclusions,
  droppedUnlisted: ForwardedRequest['droppedUnlisted']
): Pick<RequestPayload, 'excluded' | 'droppedUnlisted'> {
  const echo = echoedExclusions(exclude);
  const unlisted = {
    headers: droppedUnlisted.headers || echo.overflow.headers,
    cookies: droppedUnlisted.cookies || echo.overflow.cookies,
  };
  const hasExclusions = exclude.headers.length > 0 || exclude.cookies.length > 0;
  return {
    ...(unlisted.headers || unlisted.cookies ? { droppedUnlisted: unlisted } : {}),
    ...(hasExclusions ? { excluded: echo.excluded } : {}),
  };
}

interface Candidate {
  kind: 'header' | 'cookie';
  name: string;
  value: string;
}

/**
 * Every header and cookie but the never-forwarded, the excluded and our own
 * two cookies (which ride headers of their own). A value past its cap is
 * dropped and named; past the total, the longest default-capped values go
 * first. `namedCaps` keep their own limit and sit outside the total.
 */
export function forwardAll(
  headers: Headers,
  exclude: ForwardExclusions,
  namedCaps: ReadonlyMap<string, number>
): ForwardedRequest {
  const excludedHeaders = new Set(exclude.headers);
  const excludedCookies = new Set(exclude.cookies);
  // No prototype: a header named `__proto__` would otherwise vanish without being named anywhere.
  const out: ForwardedRequest = {
    headers: Object.create(null) as Record<string, string>,
    cookies: Object.create(null) as Record<string, string>,
    droppedHeaders: [],
    droppedCookies: [],
    droppedUnlisted: { headers: false, cookies: false },
  };
  const pooled: Candidate[] = [];

  headers.forEach((value, rawName) => {
    const name = rawName.toLowerCase();
    if (NEVER_FORWARDED_HEADERS.has(name) || excludedHeaders.has(name)) return;

    const cap = namedCaps.get(name);
    if (cap !== undefined) {
      if (value.length > cap) out.droppedHeaders.push(name);
      else out.headers[name] = value;
      return;
    }

    pooled.push({ kind: 'header', name, value });
  });

  // The first of a repeated name, as `readCookie` and most servers read it.
  const seen = new Set<string>();
  for (const [name, value] of cookiesOf(headers.get('cookie'))) {
    if (OWN_COOKIES.includes(name) || excludedCookies.has(name) || seen.has(name)) continue;

    seen.add(name);
    if (seen.size > FORWARDED_MAX_COOKIES) out.droppedCookies.push(name);
    else pooled.push({ kind: 'cookie', name, value });
  }

  for (const candidate of withinTotal(pooled, out)) {
    if (candidate.kind === 'header') out.headers[candidate.name] = candidate.value;
    else out.cookies[candidate.name] = candidate.value;
  }

  return withListedDrops(out);
}

/** Past a list's length the rest go unnamed, and the payload says some did. */
function withListedDrops(out: ForwardedRequest): ForwardedRequest {
  return {
    ...out,
    droppedHeaders: out.droppedHeaders.slice(0, FORWARDED_MAX_NAMES),
    droppedCookies: out.droppedCookies.slice(0, FORWARDED_MAX_NAMES),
    droppedUnlisted: {
      headers: out.droppedHeaders.length > FORWARDED_MAX_NAMES,
      cookies: out.droppedCookies.length > FORWARDED_MAX_NAMES,
    },
  };
}

/** Drops each over-long value, then the longest until the rest fit the total; every drop is named on `out`. */
function withinTotal(pooled: Candidate[], out: ForwardedRequest): Candidate[] {
  const drop = (c: Candidate) =>
    c.kind === 'header' ? out.droppedHeaders.push(c.name) : out.droppedCookies.push(c.name);

  const fitting: Candidate[] = [];
  for (const candidate of pooled) {
    if (candidate.value.length > FORWARDED_VALUE_MAX_LENGTH) drop(candidate);
    else fitting.push(candidate);
  }

  const size = (c: Candidate) => c.name.length + c.value.length;
  let total = fitting.reduce((sum, c) => sum + size(c), 0);
  if (total <= FORWARDED_MAX_TOTAL_LENGTH) return fitting;

  const longestFirst = [...fitting].sort((a, b) => size(b) - size(a));
  const dropped = new Set<Candidate>();
  for (const candidate of longestFirst) {
    if (total <= FORWARDED_MAX_TOTAL_LENGTH) break;

    dropped.add(candidate);
    total -= size(candidate);
    drop(candidate);
  }

  return fitting.filter((c) => !dropped.has(c));
}
