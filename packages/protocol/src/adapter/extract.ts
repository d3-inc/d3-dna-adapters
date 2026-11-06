import { ANS_ARTIFACT_MAX_BASE64_LENGTH, ANS_DPOP_MAX_PROOF_BYTES } from '../ans';
import {
  PAYMENT_AUTHORIZATION_HEADER,
  PAY_SESSION_COOKIE,
  PAY_SESSION_HEADER,
  PAY_SESSION_MAX_LENGTH,
  PERSON_PASS_COOKIE,
  PERSON_PASS_HEADER,
  PERSON_PASS_MAX_LENGTH,
  VISITOR_ID_COOKIE,
  VISITOR_ID_HEADER,
  VISITOR_ID_MAX_LENGTH,
  readCookie,
} from '../pay-session';
import { PURPOSE_HEADERS } from '../purpose';
import type { HandshakeAttestation, NetworkFacts, RequestPayload } from '../types';
import { PAYMENT_HEADER_CAPS, X402_PAYMENT_HEADERS } from '../x402/payment-header';
import { debugHeadersOf } from './debug-headers';
import { forwardAll, NO_EXCLUSIONS, withheldOf, type ForwardExclusions } from './forward-all';
import { CARRIES_MCP_SINCE, FORWARDS_ALL_SINCE } from './forwarding.constants';
import { liftedPaymentToForward, mcpCarriageOf, type McpCarriage } from './mcp';

// The staple pair plus the Method-B DPoP proof. `Authorization` is never forwarded:
// `ath` binds a token the worker must not see.
export const ANS_HEADERS = ['x-scitt-receipt', 'x-ans-status-token', 'dpop'] as const;

/** Only the 402-or-redirect decision reads these; a real `accept` is a few dozen chars. */
export const ACCEPT_MAX_LENGTH = 256;

/** A browser's navigation tells, each a short token the same decision reads. */
export const NAVIGATION_HEADERS = ['sec-fetch-mode', 'sec-fetch-dest', 'upgrade-insecure-requests'] as const;

const NAVIGATION_HEADER_MAX_LENGTH = 32;

/** The client hints and language a browser sends; their absence under a Chrome user agent is a tell (ADR 0060). */
export const HINT_HEADERS = [
  'sec-ch-ua',
  'sec-ch-ua-platform',
  'sec-ch-ua-mobile',
  'accept-language',
] as const;

const HINT_HEADER_MAX_LENGTH = 256;

/**
 * Revision of the allowlist below, stamped on every payload. The worker reads
 * a missing header as a tell only when the adapter's revision forwarded that
 * family; bump it whenever a family is added. 2 added `HINT_HEADERS`.
 */
export const FORWARDED_HEADER_SET = 2;

/**
 * Revision of what the caller does with our answer, not a package version.
 * 1 forwards `__Host-d3person` as `d3pay-person`, appends our `Set-Cookie` to
 * the origin's response, and strips `d3pay_browser` before the origin. 2
 * forwards every header and cookie but the site's exclusions. 3 lifts an MCP
 * call's payment, strips it before the origin, and answers JSON-RPC. 4 forwards
 * the visitor id by name and keeps it from the origin.
 *
 * Never stamped here, unlike `FORWARDED_HEADER_SET`: it describes the caller's
 * own response path, which `extractPayload` cannot see, so the caller passes it
 * (ADR 0068 decision 2).
 */
export const ADAPTER_SET = 4;

/**
 * Headers forwarded below revision 2, and all the worker keeps of a payload's
 * headers in its debug copy. The signature
 * headers, UA for fingerprinting, purpose claims, content-digest for body
 * coverage, the ANS staple, the payment headers and `accept`. A signature
 * covering a header outside this set comes back `missing-headers` (unverified)
 * — extend the list when a real agent needs it.
 */
export const FORWARDED_HEADERS = [
  'signature',
  'signature-input',
  'signature-agent',
  'user-agent',
  'content-digest',
  'accept',
  ...NAVIGATION_HEADERS,
  ...HINT_HEADERS,
  ...PURPOSE_HEADERS,
  ...ANS_HEADERS,
  ...X402_PAYMENT_HEADERS,
  PAYMENT_AUTHORIZATION_HEADER,
] as const;

// Per-header drop bounds: past these a value can never verify, so it must not bloat the
// decision POST. The visitor sets each header's length; the verifier re-applies both caps.
export const HEADER_LENGTH_CAPS: ReadonlyMap<string, number> = new Map([
  ['x-scitt-receipt', ANS_ARTIFACT_MAX_BASE64_LENGTH],
  ['x-ans-status-token', ANS_ARTIFACT_MAX_BASE64_LENGTH],
  ['dpop', ANS_DPOP_MAX_PROOF_BYTES],
  ['accept', ACCEPT_MAX_LENGTH],
  ...NAVIGATION_HEADERS.map((name) => [name, NAVIGATION_HEADER_MAX_LENGTH] as const),
  ...HINT_HEADERS.map((name) => [name, HINT_HEADER_MAX_LENGTH] as const),
  ...PAYMENT_HEADER_CAPS,
]);

/** Per-adapter inputs the platform resolves differently (e.g. the client IP). */
export interface ExtractOptions {
  /**
   * Client IP, resolved by the caller — Cloudflare reads `cf-connecting-ip`,
   * Vercel uses `ipAddress(request)`. Kept out of core so it stays platform-free.
   */
  ip?: string;
  /** Client cert as the TLS terminator saw it — only a terminator may set it (ADR 0021 decision 3). */
  handshake?: HandshakeAttestation;
  /** Every header but the credentials as `debugHeaders`, for the request record alone; off in production. */
  debugHeaders?: boolean;
  /** Connection facts the platform exposes (Cloudflare `request.cf`, Vercel geolocation); logged, never verified. */
  network?: NetworkFacts;
  /** `ADAPTER_SET` when the caller honours that revision; absent means it does not (ADR 0068). */
  adapterSet?: number;
  /** Names the site keeps back, from revision 2 on. */
  exclude?: ForwardExclusions;
}

export interface EdgeRequest {
  payload: RequestPayload;
  /** Revision 3 only: the MCP call, and what to take out of it before the origin. */
  mcp: McpCarriage | null;
}

/** Platform-agnostic: the caller supplies the client IP via `opts.ip` (design doc §4.3). */
export async function extractPayload(request: Request, opts: ExtractOptions = {}): Promise<RequestPayload> {
  return (await extractEdgeRequest(request, opts)).payload;
}

/** `extractPayload`, plus what a revision 3 adapter needs to answer an MCP call. */
export async function extractEdgeRequest(request: Request, opts: ExtractOptions = {}): Promise<EdgeRequest> {
  const url = new URL(request.url);
  const revision = opts.adapterSet ?? 0;
  const exclude = opts.exclude ?? NO_EXCLUSIONS;
  const forwardsAll = revision >= FORWARDS_ALL_SINCE;

  const forwarded = forwardsAll
    ? forwardAll(request.headers, exclude, HEADER_LENGTH_CAPS)
    : {
        ...allowlisted(request.headers),
        cookies: {},
        droppedCookies: [],
        droppedUnlisted: { headers: false, cookies: false },
      };
  const { headers, droppedHeaders, cookies, droppedCookies, droppedUnlisted } = forwarded;

  // Our two cookies by name, each as a header of its own; the `Cookie` header itself is the site's and stays there.
  const cookie = request.headers.get('cookie');
  forwardCookie(headers, cookie, PAY_SESSION_COOKIE, PAY_SESSION_HEADER, PAY_SESSION_MAX_LENGTH);
  forwardCookie(headers, cookie, PERSON_PASS_COOKIE, PERSON_PASS_HEADER, PERSON_PASS_MAX_LENGTH);
  forwardCookie(headers, cookie, VISITOR_ID_COOKIE, VISITOR_ID_HEADER, VISITOR_ID_MAX_LENGTH);

  // Overwrite content-digest with the real body's digest so a tampered body
  // fails verification downstream. Do it whenever there's a body OR a claimed
  // digest — an empty body must not smuggle a forged digest past this (§9) —
  // but never add one to a request that has neither (that would fail body-less
  // signed requests as insufficient-coverage).
  const canHaveBody = request.method !== 'GET' && request.method !== 'HEAD';
  const body =
    canHaveBody && request.body !== null ? await request.clone().arrayBuffer() : new ArrayBuffer(0);
  if (body.byteLength > 0 || 'content-digest' in headers) {
    headers['content-digest'] = await sha256ContentDigest(body);
  }

  const mcp = revision >= CARRIES_MCP_SINCE ? mcpCarriageOf(request, body, exclude.headers) : null;
  for (const [name, value] of Object.entries(liftedPaymentToForward(request.headers, mcp?.lifted ?? {}))) {
    // The site's exclusion binds a lifted credential as it binds the header; the origin loses it either way.
    if (exclude.headers.includes(name)) continue;

    const cap = HEADER_LENGTH_CAPS.get(name);
    if (cap !== undefined && value.length > cap) droppedHeaders.push(name);
    else headers[name] = value;
  }

  const payload: RequestPayload = {
    ip: opts.ip,
    handshake: opts.handshake,
    network: opts.network,
    headerSet: FORWARDED_HEADER_SET,
    ...(opts.adapterSet === undefined ? {} : { adapterSet: opts.adapterSet }),
    secure: url.protocol === 'https:',
    ...(droppedHeaders.length > 0 ? { droppedHeaders } : {}),
    method: request.method,
    url: url.pathname + url.search,
    host: url.host,
    timestamp: new Date().toISOString(),
    headers,
    ...(forwardsAll ? { cookies } : {}),
    ...(droppedCookies.length > 0 ? { droppedCookies } : {}),
    ...(forwardsAll ? withheldOf(exclude, droppedUnlisted) : {}),
    ...(mcp?.facts ? { mcp: mcp.facts } : {}),
    ...(opts.debugHeaders
      ? { debugHeaders: debugHeadersOf(entriesOf(request.headers), exclude.headers) }
      : {}),
  };
  return { payload, mcp };
}

/** Below revision 2: the fixed list, each header under its cap. */
function allowlisted(source: Headers): { headers: Record<string, string>; droppedHeaders: string[] } {
  const headers: Record<string, string> = {};
  const droppedHeaders: string[] = [];
  for (const name of FORWARDED_HEADERS) {
    const value = source.get(name);
    if (value === null) continue;

    const cap = HEADER_LENGTH_CAPS.get(name);
    if (cap !== undefined && value.length > cap) {
      droppedHeaders.push(name);
      continue;
    }

    headers[name] = value;
  }

  return { headers, droppedHeaders };
}

/** `Headers` iterates only under `dom.iterable`, which not every adapter's lib has. */
function entriesOf(headers: Headers): [string, string][] {
  const pairs: [string, string][] = [];
  headers.forEach((value, name) => pairs.push([name, value]));
  return pairs;
}

/** RFC 9530 Content-Digest field value for a body, sha-256 only. */
export async function sha256ContentDigest(body: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', body);
  let binary = '';
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return `sha-256=:${btoa(binary)}:`;
}

function forwardCookie(
  headers: Record<string, string>,
  cookie: string | null,
  name: string,
  header: string,
  maxLength: number
): void {
  const value = readCookie(cookie, name);
  if (value !== null && value.length > 0 && value.length <= maxLength) headers[header] = value;
}
