import { isNamespaceCookie } from '../namespace';
import type { RequestPayload } from '../types';
import { DNA_ADAPTER_HEADER } from './adapter-name';

/** Ours on every site from revision 4: the check script posts its answer here, on the site's own host. */
export const CHECK_RELAY_PATH = '/.well-known/d3/check';

/** Every source and probe the script sends fits several times over; past this the post is not ours. */
export const CHECK_RELAY_MAX_BODY_BYTES = 32 * 1024;

/** A person waits on this post, so it gets the hot path's order of budget, with room to store the answer. */
export const DEFAULT_CHECK_RELAY_TIMEOUT_MS = 5000;

/** `x-d3-edge` on everything the relay answers. */
export const CHECK_RELAY_EDGE_MODE = 'check';

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
  /** The caller's logger: the Snippet cannot afford the protocol's, so none is imported here. */
  logError: (message: string, detail?: Record<string, unknown>) => void;
}

export function isCheckRelayPath(url: string): boolean {
  return new URL(url).pathname === CHECK_RELAY_PATH;
}

const DECISION_PATH_SUFFIX = '/v1/decision';

/**
 * `/v1/check` beside the decision path, prefix kept: a gateway that routes by path then routes both alike. An
 * endpoint not ending in the decision path gets no relay (null), rather than the key sent to a guessed route.
 */
export function checkEndpointOf(decisionUrl: string): string | null {
  const url = new URL(decisionUrl);
  if (!url.pathname.endsWith(DECISION_PATH_SUFFIX)) return null;

  url.pathname = `${url.pathname.slice(0, -DECISION_PATH_SUFFIX.length)}/v1/check`;
  url.search = '';
  url.hash = '';
  return url.toString();
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

/** The post as text, or null when it is not UTF-8: decoding it lossily would relay an answer nobody posted. */
function utf8Of(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * The script posts with `fetch` from the page itself. A browser that names the post cross-site was sent here by
 * another site's form, which could plant a result for a visitor who never ran the check. No header: let it by.
 */
export function isCrossSitePost(request: Request): boolean {
  const site = request.headers.get('sec-fetch-site');
  return site !== null && site !== 'same-origin';
}

const REFUSALS = {
  400: 'malformed',
  403: 'cross-site',
  405: 'method-not-allowed',
  413: 'too-large',
  503: 'check-unavailable',
} as const;

const RELAY_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'x-d3-edge': CHECK_RELAY_EDGE_MODE,
} as const;

export function checkRelayRefusal(status: keyof typeof REFUSALS): Response {
  const headers: Record<string, string> = { ...RELAY_HEADERS };
  if (status === 405) headers.allow = 'POST';

  return Response.json({ error: REFUSALS[status] }, { status, headers });
}

/** A cookie's name, or null for a line with no `=`, which a browser would store as a nameless cookie. */
function cookieNameOf(setCookie: string): string | null {
  const eq = setCookie.indexOf('=');
  return eq === -1 ? null : setCookie.slice(0, eq).trim();
}

function isJson(contentType: string | null): boolean {
  return contentType !== null && /^application\/json\s*(;|$)/i.test(contentType);
}

/**
 * The check worker's answer, served on the site's own host: JSON only, never sniffed, so nothing in it can run
 * as the site's page; only cookies of ours, so even a misbehaving endpoint cannot set the site's own. A key the
 * endpoint refused is the site's problem to read in its logs, not a visitor's: it answers as unavailable.
 */
export function relayedCheckResponse(upstream: Response): Response {
  if (upstream.status === 401 || upstream.status === 403) return checkRelayRefusal(503);

  if (!isJson(upstream.headers.get('content-type'))) return checkRelayRefusal(503);

  const headers = new Headers({ ...RELAY_HEADERS, 'content-type': 'application/json' });
  for (const cookie of upstream.headers.getSetCookie()) {
    const name = cookieNameOf(cookie);
    if (name !== null && isNamespaceCookie(name)) headers.append('set-cookie', cookie);
  }

  return new Response(upstream.body, { status: upstream.status, headers });
}

/**
 * Answers the check script's post, never the origin: 405 for another method, 403 for a cross-site post, 413
 * past the cap, 400 for an empty or non-UTF-8 one, and 503 when the check endpoint cannot answer, so the script shows its card rather than the
 * site's error page. The budget covers reading the post too, so a trickled body cannot hold the relay open.
 */
export async function relayCheckPost(request: Request, opts: CheckRelayOptions): Promise<Response> {
  if (request.method !== 'POST') return checkRelayRefusal(405);

  if (isCrossSitePost(request)) return checkRelayRefusal(403);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const body = await Promise.race([
      readCappedBody(request, CHECK_RELAY_MAX_BODY_BYTES),
      new Promise<never>((_resolve, reject) =>
        controller.signal.addEventListener('abort', () => reject(new Error('check relay budget spent')))
      ),
    ]);
    if (!body.ok) return checkRelayRefusal(413);

    const answer = utf8Of(body.bytes);
    if (answer === null || answer === '') return checkRelayRefusal(400);

    const payload = await opts.payloadOf(
      new Request(request.url, { method: 'POST', headers: request.headers, body: body.bytes })
    );
    const relayed: CheckRelayBody = { payload, answer };
    const upstream = await opts.fetch(opts.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(opts.bearer === undefined ? {} : { authorization: `Bearer ${opts.bearer}` }),
        ...(opts.adapterName === undefined ? {} : { [DNA_ADAPTER_HEADER]: opts.adapterName }),
      },
      body: JSON.stringify(relayed),
      // A redirect would carry the key to wherever it points.
      redirect: 'manual',
      signal: controller.signal,
    });
    if (upstream.status >= 300 && upstream.status < 400) return checkRelayRefusal(503);

    if (upstream.status === 401 || upstream.status === 403) {
      opts.logError(`check relay rejected: HTTP ${upstream.status} — check DNA_API_KEY / key status`);
    }

    // Read inside the budget: an endpoint that stalls mid-body would otherwise hold the visitor's post open.
    const text = await upstream.text();
    return relayedCheckResponse(new Response(text, { status: upstream.status, headers: upstream.headers }));
  } catch (err) {
    opts.logError('check relay failed', { err });
    return checkRelayRefusal(503);
  } finally {
    clearTimeout(timer);
  }
}
