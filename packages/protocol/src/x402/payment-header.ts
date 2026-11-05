import { MCP_DNA_KEY_HEADER } from '../adapter/forwarding.constants';
import {
  PAYMENT_AUTHORIZATION_HEADER,
  PAYMENT_AUTHORIZATION_MAX_LENGTH,
  PAY_SESSION_HEADER,
  PAY_SESSION_MAX_LENGTH,
  PERSON_PASS_COOKIE,
  PERSON_PASS_HEADER,
  handoffFromUrl,
  readCookie,
  readSessionCookie,
  stripOwnCookies,
  stripPayParams,
} from '../pay-session';

// Two names because x402 v2 renamed it and an adapter cannot know which
// version a caller speaks, so both are forwarded and the worker's decoder
// picks. The RESPONSE version comes from the decoded payload, not from which
// header carried it.
export const X402_PAYMENT_HEADER_V2 = 'payment-signature';

export const X402_PAYMENT_HEADER_V1 = 'x-payment';

export const X402_PAYMENT_HEADERS = [X402_PAYMENT_HEADER_V2, X402_PAYMENT_HEADER_V1] as const;

/** Every header that carries one of our credentials on the payload. */
export const DNA_CREDENTIAL_HEADERS: readonly string[] = [
  PAYMENT_AUTHORIZATION_HEADER,
  PAY_SESSION_HEADER,
  PERSON_PASS_HEADER,
  ...X402_PAYMENT_HEADERS,
];

/**
 * `btoa` throws above U+00FF, so a token naming itself `Tether₮` would 500 the
 * challenge. The provider's own encoder has that bug; do not copy it.
 */
export function base64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Base64 of a 132-char signature plus six short fields, so this is generous by
 * an order of magnitude. It is what stops an oversized blob being decoded at
 * all on the trust core's request path.
 */
export const X402_MAX_PAYMENT_HEADER_LENGTH = 4096;

/** Every header that presents a payment, with the length past which it is not one (ADR 0044 decision 6). */
export const PAYMENT_HEADER_CAPS: ReadonlyMap<string, number> = new Map([
  ...X402_PAYMENT_HEADERS.map((name) => [name, X402_MAX_PAYMENT_HEADER_LENGTH] as const),
  [PAYMENT_AUTHORIZATION_HEADER, PAYMENT_AUTHORIZATION_MAX_LENGTH],
  [PAY_SESSION_HEADER, PAY_SESSION_MAX_LENGTH],
]);

export const PAYMENT_HEADERS: readonly string[] = [...PAYMENT_HEADER_CAPS.keys()];

/**
 * Also the browser-check pass and the mirrored DNA key, credentials the origin
 * must never see but not payments: keeping them out of `PAYMENT_HEADER_CAPS` is
 * what stops them buying the payment timeout budget.
 */
const ORIGIN_STRIPPED_HEADERS: readonly string[] = [
  ...PAYMENT_HEADERS,
  PERSON_PASS_HEADER,
  MCP_DNA_KEY_HEADER,
];

/**
 * A payment in any of the three places one can ride: a header, our cookie, or a
 * handoff on the URL. A place left out is a redemption answered on the adapter's
 * 500 ms unpaid budget, and blocked when it overruns.
 */
export function requestPresentsPayment(request: Request): boolean {
  return hasPaymentHeader(request.headers) || handoffFromUrl(request.url) !== null;
}

/**
 * Presence only, never a decode: this runs in the adapter, on the customer's
 * own infrastructure, which must not parse a payment. On a real request the
 * session arrives as a cookie; on a payload it is the forwarded header.
 */
export function hasPaymentHeader(headers: Headers | Record<string, string>): boolean {
  const get = (name: string) => (headers instanceof Headers ? headers.get(name) : (headers[name] ?? null));

  for (const [name, cap] of PAYMENT_HEADER_CAPS) {
    const value = get(name);
    if (value !== null && value.length > 0 && value.length <= cap) return true;
  }

  const cookie = headers instanceof Headers ? readSessionCookie(headers.get('cookie')) : null;
  return cookie !== null && cookie.length > 0 && cookie.length <= PAY_SESSION_MAX_LENGTH;
}

/**
 * The request without any DNA credential, for the origin fetch: no payment
 * header, neither of our cookies, and no handoff, auth check or browser check
 * left on the URL. The origin sees the receipt on its response and never a
 * credential it could replay.
 */
export function stripPaymentHeaders(request: Request): Request {
  const cookie = request.headers.get('cookie');
  const hasCookie =
    cookie !== null &&
    (readSessionCookie(cookie) !== null || readCookie(cookie, PERSON_PASS_COOKIE) !== null);
  const url = stripPayParams(request.url);
  const hasHeader = ORIGIN_STRIPPED_HEADERS.some((name) => request.headers.has(name));
  if (!hasCookie && !hasHeader && url === request.url) return request;

  const headers = new Headers(request.headers);
  for (const name of ORIGIN_STRIPPED_HEADERS) headers.delete(name);

  if (hasCookie) {
    const kept = stripOwnCookies(cookie);
    if (kept === null) headers.delete('cookie');
    else headers.set('cookie', kept);
  }

  if (url === request.url) return new Request(request, { headers });

  const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body;
  return new Request(url, {
    method: request.method,
    headers,
    body,
    redirect: request.redirect,
    signal: request.signal,
    // A streamed body needs it on undici, and workerd ignores it.
    ...(body ? { duplex: 'half' } : {}),
  } as RequestInit);
}
