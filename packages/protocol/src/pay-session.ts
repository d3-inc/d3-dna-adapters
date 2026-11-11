import { isNamespaceCookie, isNamespaceParam } from './namespace';
/**
 * The pay credentials as they travel: header and cookie names, their caps, the
 * URL params, and the readers that parse them. Session signing and the KV
 * records stay in the policy worker, so nothing here holds a secret.
 */

/** MPP's credential header: the adapters forward it under its cap and keep it from the origin, and the worker reads nothing in it. */
export const PAYMENT_AUTHORIZATION_HEADER = 'payment-authorization';

/** MPP's credentials (ADR 0055 decision 3) run to a few KB; a DNA account key needs far less. */
export const PAYMENT_AUTHORIZATION_MAX_LENGTH = 4096;

/** `__Host-` pins the cookie to the site's origin: no `Domain`, `Path=/`, `Secure`. */
export const PAY_SESSION_COOKIE = '__Host-d3pay';

/** The adapter forwards the cookie's value under this name; the raw `Cookie` header never leaves the site. */
export const PAY_SESSION_HEADER = 'd3pay-session';

export const PAY_SESSION_TOKEN_LENGTH = 43;

export const PAY_SESSION_MAX_LENGTH = 64;

/** The browser-check pass (ADR 0057): a person's browser reads a check route free while it holds. */
export const PERSON_PASS_COOKIE = '__Host-d3person';

export const PERSON_PASS_HEADER = 'd3pay-person';

/** `<13-digit expiry>.<43-char signature>` is 57; the cap leaves no room for anything else. */
export const PERSON_PASS_MAX_LENGTH = 64;

/**
 * The visitor id (ADR 0087), two names because the scope decides: a delegated
 * zone shares one id across its hosts with a `Domain`, which `__Host-` forbids,
 * and a host we know on its own takes `__Host-`, which no sibling can plant.
 * Both ride the cookie map rather than a header of their own.
 */
export const VISITOR_ID_ZONE_COOKIE = '__Secure-d3visitor';

export const VISITOR_ID_HOST_COOKIE = '__Host-d3visitor';

/** The browser check's signals ride back to the page under this name, base64url JSON. */
export const BROWSER_CHECK_PARAM = 'd3pay_browser';

export const BROWSER_CHECK_PARAM_MAX_LENGTH = 4096;

export const PAY_HANDOFF_PARAM = 'd3pay_handoff';

/** The pay app's answer, beside the handoff, on a return from `/policy-worker/auth`. */
export const PAY_AUTH_CHECK_PARAM = 'd3pay_check';

/** `from=paywall` on the approval page's URL: the origin's paywall opened it, so once approved it opens the site. */
export const PAY_FROM_PARAM = 'from';

export const PAY_FROM_PAYWALL = 'paywall';

export type PayCredential = { kind: 'session'; token: string } | { kind: 'handoff'; token: string };

const HANDOFF_ID_LENGTH = 22;

const HANDOFF_SIG_LENGTH = 43;

const BASE64URL = /^[A-Za-z0-9_-]+$/;

export interface HandoffParts {
  id: string;
  signature: string;
}

export function splitHandoffToken(token: string): HandoffParts | null {
  const dot = token.indexOf('.');
  if (dot !== HANDOFF_ID_LENGTH) return null;

  const id = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  if (signature.length !== HANDOFF_SIG_LENGTH || !BASE64URL.test(id) || !BASE64URL.test(signature)) {
    return null;
  }

  return { id, signature };
}

export function isWellFormedSessionToken(token: string): boolean {
  return token.length === PAY_SESSION_TOKEN_LENGTH && BASE64URL.test(token);
}

/**
 * Escape by escape, because one bad byte must not hide the rest: a whole-string
 * `decodeURIComponent` throws on `%FF` and hands back the name still encoded, so
 * `d3pay%5Flater%FF` read as a site's parameter and reached its origin.
 */
function paramName(pair: string): string {
  return pair
    .split('=', 1)[0]
    .replaceAll('+', ' ')
    .replace(/%[0-9A-Fa-f]{2}/g, (escape) => {
      try {
        return decodeURIComponent(escape);
      } catch {
        return escape;
      }
    });
}

/** The handoff a caller with no cookie jar appends to the URL; null when absent or malformed. */
export function handoffFromUrl(url: string): string | null {
  const query = url.indexOf('?');
  if (query === -1) return null;

  const value = new URLSearchParams(url.slice(query + 1)).get(PAY_HANDOFF_PARAM);
  return value !== null && splitHandoffToken(value) ? value : null;
}

/** The URL without the handoff, the auth check or the browser check: where a redeemed browser is sent, what the record keeps, and what the origin is asked for. */
export function stripPayParams(url: string): string {
  const query = url.indexOf('?');
  if (query === -1) return url;

  const kept = url
    .slice(query + 1)
    .split('&')
    .filter((pair) => !isNamespaceParam(paramName(pair)));
  return kept.length > 0 ? `${url.slice(0, query)}?${kept.join('&')}` : url.slice(0, query);
}

export function handoffFetchUrl(host: string, url: string, token: string): string {
  const clean = stripPayParams(url);
  return `https://${host}${clean}${clean.includes('?') ? '&' : '?'}${PAY_HANDOFF_PARAM}=${token}`;
}

/** Presence under the caps, never a decode: the adapters and the worker pick a budget with this. */
export function presentsPayCredential(headers: Record<string, string>, url: string): boolean {
  const session = headers[PAY_SESSION_HEADER];
  if (typeof session === 'string' && session.length > 0 && session.length <= PAY_SESSION_MAX_LENGTH) {
    return true;
  }

  return handoffFromUrl(url) !== null;
}

/** The name a `Cookie` pair declares, whatever spacing surrounds it. */
function cookieName(pair: string): string {
  const eq = pair.indexOf('=');
  return (eq === -1 ? pair : pair.slice(0, eq)).trim();
}

/** One cookie's value out of a `Cookie` header, wherever it sits; null when absent. */
export function readCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const pair of cookieHeader.split(';')) {
    const eq = pair.indexOf('=');
    if (eq !== -1 && cookieName(pair) === name) return pair.slice(eq + 1).trim();
  }

  return null;
}

export function readSessionCookie(cookieHeader: string | null): string | null {
  return readCookie(cookieHeader, PAY_SESSION_COOKIE);
}

/** Every cookie in a `Cookie` header as `[name, value]`, in order, names read as `readCookie` reads them. */
export function cookiesOf(cookieHeader: string | null): [string, string][] {
  if (!cookieHeader) return [];

  const out: [string, string][] = [];
  for (const pair of cookieHeader.split(';')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;

    const name = cookieName(pair);
    if (name !== '') out.push([name, pair.slice(eq + 1).trim()]);
  }

  return out;
}

/** Ours, never the site's: each rides a header of its own, and neither reaches the origin. */
export const OWN_COOKIES: readonly string[] = [PAY_SESSION_COOKIE, PERSON_PASS_COOKIE];

/**
 * The cookies the endpoint sets today. The prefix is a label no browser
 * enforces, so any script on the host can mint one: a name here keeps its place
 * however many others turn up wearing it.
 */
export const RESERVED_COOKIES: readonly string[] = [
  ...OWN_COOKIES,
  VISITOR_ID_ZONE_COOKIE,
  VISITOR_ID_HOST_COOKIE,
];

/**
 * Names are compared the way `readCookie` reads them, never as a `name=`
 * prefix: `__Host-d3person =x` is one cookie to every browser and to us, and a
 * prefix test leaves it in the header the origin receives.
 */
function stripCookies(cookieHeader: string, ours: (name: string) => boolean): string | null {
  const kept = cookieHeader
    .split(';')
    .map((pair) => pair.trim())
    .filter((pair) => pair.length > 0 && !ours(cookieName(pair)));
  return kept.length > 0 ? kept.join('; ') : null;
}

/** The `Cookie` header without the pay session, kept for callers that predate the browser-check pass. */
export function stripSessionCookie(cookieHeader: string): string | null {
  return stripCookies(cookieHeader, (name) => name === PAY_SESSION_COOKIE);
}

/** The `Cookie` header with every cookie of ours removed, or null when nothing is left. */
export function stripOwnCookies(cookieHeader: string): string | null {
  return stripCookies(cookieHeader, isNamespaceCookie);
}

/**
 * Whether the jar holds anything of ours, which is what makes a strip worth
 * building a request for. Read the way `stripCookies` reads a name and not the
 * way `cookiesOf` does: a pair with no `=` is a cookie name to the stripper, so
 * asking a stricter question here would skip the strip that removes it.
 */
export function holdsOwnCookie(cookieHeader: string): boolean {
  return cookieHeader.split(';').some((pair) => isNamespaceCookie(cookieName(pair.trim())));
}

/** The `Set-Cookie` value a redemption rides to the browser; `Lax` is what a top-level redirect sends. */
export function sessionSetCookie(token: string, maxAgeSeconds: number): string {
  return `${PAY_SESSION_COOKIE}=${token}; Path=/; Max-Age=${maxAgeSeconds}; Secure; HttpOnly; SameSite=Lax`;
}
