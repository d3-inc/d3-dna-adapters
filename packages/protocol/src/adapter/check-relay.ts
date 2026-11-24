import { edgeLogger } from '../logging/logger';
import { isNamespaceCookie } from '../namespace';
import type { RequestPayload } from '../types';
import { DNA_ADAPTER_HEADER } from './adapter-name';

const log = edgeLogger('check-relay');

/** Ours on every site from revision 4: the check script posts its answer here, on the site's own host. */
export const CHECK_RELAY_PATH = '/.well-known/d3/check';

/** Every source and probe the script sends fits several times over; past this the post is not ours. */
export const CHECK_RELAY_MAX_BODY_BYTES = 32 * 1024;

/** A person waits on this post, so it gets the hot path's order of budget, with room to store the answer. */
export const DEFAULT_CHECK_RELAY_TIMEOUT_MS = 5000;

/** What the relay sends the check worker: the request as a decision call describes it, and the posted answer. */
export interface CheckRelayBody {
  payload: RequestPayload;
  answer: string;
}

export interface CheckRelayOptions {
  /** The check endpoint, `checkEndpointOf(DNA_ENDPOINT)`, or a binding's placeholder. */
  url: string;
  bearer?: string;
  adapterName?: string;
  timeoutMs: number;
  fetch: typeof fetch;
  /** The caller's own `extractEdgeRequest`, so the check sees the network facts a decision call sends. */
  payloadOf: (request: Request) => Promise<RequestPayload>;
}

export function isCheckRelayPath(url: string): boolean {
  return new URL(url).pathname === CHECK_RELAY_PATH;
}

/** The check worker answers on the decision endpoint's own host, so a site sets one endpoint for both. */
export function checkEndpointOf(decisionUrl: string): string {
  return new URL('/v1/check', decisionUrl).toString();
}

export type CappedBody = { ok: true; bytes: Uint8Array<ArrayBuffer> } | { ok: false };

/** Reads at most `maxBytes`, never the rest: a declared or streamed body past the cap is refused unread. */
export async function readCappedBody(request: Request, maxBytes: number): Promise<CappedBody> {
  const declared = Number(request.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false };

  if (request.body === null) return { ok: true, bytes: new Uint8Array(0) };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return { ok: false };
    }

    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { ok: true, bytes };
}

const REFUSALS = {
  405: 'method-not-allowed',
  413: 'too-large',
  503: 'check-unavailable',
} as const;

/** `x-d3-edge` on everything the relay answers. */
export const CHECK_RELAY_EDGE_MODE = 'check';

export function checkRelayRefusal(status: keyof typeof REFUSALS): Response {
  const headers: Record<string, string> = { 'cache-control': 'no-store', 'x-d3-edge': CHECK_RELAY_EDGE_MODE };
  if (status === 405) headers.allow = 'POST';

  return Response.json({ error: REFUSALS[status] }, { status, headers });
}

function cookieNameOf(setCookie: string): string {
  const eq = setCookie.indexOf('=');
  return (eq === -1 ? setCookie : setCookie.slice(0, eq)).trim();
}

/**
 * The check worker's answer on the site's own host: its status, body and type, and only cookies of ours, so
 * even a check endpoint that misbehaved could not set the site's cookies. Never cached.
 */
export function relayedCheckResponse(upstream: Response): Response {
  const headers = new Headers({ 'cache-control': 'no-store', 'x-d3-edge': CHECK_RELAY_EDGE_MODE });
  const type = upstream.headers.get('content-type');
  if (type !== null) headers.set('content-type', type);

  for (const cookie of upstream.headers.getSetCookie()) {
    if (isNamespaceCookie(cookieNameOf(cookie))) headers.append('set-cookie', cookie);
  }

  return new Response(upstream.body, { status: upstream.status, headers });
}

/**
 * Answers the check script's post, never the origin: 405 for another method, 413 past the cap, and 503 when
 * the check endpoint cannot answer, so the script shows its card rather than the site's error page.
 */
export async function relayCheckPost(request: Request, opts: CheckRelayOptions): Promise<Response> {
  if (request.method !== 'POST') return checkRelayRefusal(405);

  const body = await readCappedBody(request, CHECK_RELAY_MAX_BODY_BYTES);
  if (!body.ok) return checkRelayRefusal(413);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const payload = await opts.payloadOf(
      new Request(request.url, { method: 'POST', headers: request.headers, body: body.bytes })
    );
    const relayed: CheckRelayBody = { payload, answer: new TextDecoder().decode(body.bytes) };
    const upstream = await opts.fetch(opts.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(opts.bearer === undefined ? {} : { authorization: `Bearer ${opts.bearer}` }),
        ...(opts.adapterName === undefined ? {} : { [DNA_ADAPTER_HEADER]: opts.adapterName }),
      },
      body: JSON.stringify(relayed),
      signal: controller.signal,
    });
    if (upstream.status === 401 || upstream.status === 403) {
      log.error(`check relay rejected: HTTP ${upstream.status} — check DNA_API_KEY / key status`);
    }

    return relayedCheckResponse(upstream);
  } catch (err) {
    log.error('check relay failed', { err });
    return checkRelayRefusal(503);
  } finally {
    clearTimeout(timer);
  }
}
