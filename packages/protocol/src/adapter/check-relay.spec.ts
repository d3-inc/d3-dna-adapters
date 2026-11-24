import { describe, expect, it, vi } from 'vitest';
import type { RequestPayload } from '../types';
import {
  CHECK_RELAY_MAX_BODY_BYTES,
  CHECK_RELAY_PATH,
  checkEndpointOf,
  isCheckRelayPath,
  readCappedBody,
  relayCheckPost,
  relayedCheckResponse,
  type CheckRelayBody,
  type CheckRelayOptions,
} from './check-relay';

const SITE = 'https://shop.example';
const CHECK_URL = 'https://edge-api.d3.com/v1/check';
const ANSWER = JSON.stringify({ v: 2, offer: 'o', signals: {} });

function post(body: BodyInit | null, init: RequestInit = {}): Request {
  const streamed = body instanceof ReadableStream ? { duplex: 'half' } : {};
  return new Request(`${SITE}${CHECK_RELAY_PATH}`, {
    method: 'POST',
    body,
    ...streamed,
    ...init,
  } as RequestInit);
}

function streamOf(sizes: number[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const size of sizes) controller.enqueue(new Uint8Array(size));
      controller.close();
    },
  });
}

describe('isCheckRelayPath', () => {
  it('is the reserved path exactly, whatever the query', () => {
    expect(isCheckRelayPath(`${SITE}${CHECK_RELAY_PATH}`)).toBe(true);
    expect(isCheckRelayPath(`${SITE}${CHECK_RELAY_PATH}?x=1`)).toBe(true);
  });

  it('is not a path beside it, below it, or that resolves away from it', () => {
    expect(isCheckRelayPath(`${SITE}${CHECK_RELAY_PATH}/`)).toBe(false);
    expect(isCheckRelayPath(`${SITE}${CHECK_RELAY_PATH}x`)).toBe(false);
    expect(isCheckRelayPath(`${SITE}/.well-known/d3/CHECK`)).toBe(false);
    expect(isCheckRelayPath(`${SITE}${CHECK_RELAY_PATH}/../page`)).toBe(false);
    expect(isCheckRelayPath(`${SITE}/page?next=${CHECK_RELAY_PATH}`)).toBe(false);
  });
});

describe('checkEndpointOf', () => {
  it('is /v1/check on the decision endpoint host, whatever its path', () => {
    expect(checkEndpointOf('https://edge-api.d3.com/v1/decision')).toBe(CHECK_URL);
    expect(checkEndpointOf('https://dna.example:8443/proxy/v1/decision?x=1')).toBe(
      'https://dna.example:8443/v1/check'
    );
  });
});

describe('readCappedBody', () => {
  it('reads a body up to the cap whole', async () => {
    const read = await readCappedBody(post(streamOf([10, 20])), 30);
    expect(read).toEqual({ ok: true, bytes: new Uint8Array(30) });
  });

  it('refuses a declared length past the cap without reading it', async () => {
    const request = post('x', { headers: { 'content-length': '31' } });
    expect(await readCappedBody(request, 30)).toEqual({ ok: false });
    expect(request.bodyUsed).toBe(false);
  });

  it('refuses a streamed body past the cap, whatever it declared', async () => {
    expect(await readCappedBody(post(streamOf([20, 20])), 30)).toEqual({ ok: false });
  });

  it('reads no body as empty', async () => {
    expect(await readCappedBody(new Request(SITE, { method: 'POST' }), 30)).toEqual({
      ok: true,
      bytes: new Uint8Array(0),
    });
  });
});

describe('relayedCheckResponse', () => {
  it("keeps the check worker's status, body and type, and is never cached", async () => {
    const upstream = Response.json({ next: 'reload' }, { status: 200, headers: { 'x-internal': 'secret' } });
    const relayed = relayedCheckResponse(upstream);
    expect(relayed.status).toBe(200);
    expect(await relayed.json()).toEqual({ next: 'reload' });
    expect(relayed.headers.get('content-type')).toBe('application/json');
    expect(relayed.headers.get('cache-control')).toBe('no-store');
    expect(relayed.headers.get('x-d3-edge')).toBe('check');
    expect(relayed.headers.get('x-internal')).toBeNull();
  });

  it('passes only cookies of ours, so a check endpoint cannot set the site its own', () => {
    const headers = new Headers();
    headers.append('set-cookie', '__Host-d3check=sealed; Path=/; Secure; HttpOnly; SameSite=Lax');
    headers.append('set-cookie', 'session=hijacked; Path=/');
    headers.append('set-cookie', '__Host-d3_acquisition=x; Path=/');
    const relayed = relayedCheckResponse(new Response(null, { status: 204, headers }));
    expect(relayed.headers.getSetCookie()).toEqual([
      '__Host-d3check=sealed; Path=/; Secure; HttpOnly; SameSite=Lax',
    ]);
  });
});

describe('relayCheckPost', () => {
  const payload = { host: 'shop.example' } as RequestPayload;

  function options(fetchImpl: typeof fetch, over: Partial<CheckRelayOptions> = {}): CheckRelayOptions {
    return {
      url: CHECK_URL,
      bearer: 'd3_k_key',
      adapterName: 'cloudflare:9.9.9',
      timeoutMs: 1000,
      fetch: fetchImpl,
      payloadOf: () => Promise.resolve(payload),
      ...over,
    };
  }

  it('posts the payload and the answer to the check endpoint under the adapter key', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(Response.json({ next: 'reload' })));
    const response = await relayCheckPost(post(ANSWER), options(fetchImpl));

    expect(response.status).toBe(200);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(CHECK_URL);
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({
      authorization: 'Bearer d3_k_key',
      'content-type': 'application/json',
      'dna-adapter': 'cloudflare:9.9.9',
    });
    expect(JSON.parse(init?.body as string)).toEqual({ payload, answer: ANSWER } satisfies CheckRelayBody);
  });

  it('builds the payload from the request it was posted, body included', async () => {
    const seen: string[] = [];
    const payloadOf = async (request: Request) => {
      seen.push(`${request.method} ${request.url} ${await request.text()}`);
      return payload;
    };

    await relayCheckPost(
      post(ANSWER),
      options(() => Promise.resolve(new Response(null)), { payloadOf })
    );
    expect(seen).toEqual([`POST ${SITE}${CHECK_RELAY_PATH} ${ANSWER}`]);
  });

  it('answers 405 to another method and relays nothing', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const response = await relayCheckPost(new Request(`${SITE}${CHECK_RELAY_PATH}`), options(fetchImpl));
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
    expect(response.headers.get('x-d3-edge')).toBe('check');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('answers 413 past the cap and relays nothing', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const response = await relayCheckPost(
      post(streamOf([CHECK_RELAY_MAX_BODY_BYTES + 1])),
      options(fetchImpl)
    );
    expect(response.status).toBe(413);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('answers 503 when the check endpoint cannot be reached, or the payload cannot be built', async () => {
    const down = await relayCheckPost(
      post(ANSWER),
      options(() => Promise.reject(new Error('unreachable')))
    );
    expect(down.status).toBe(503);
    expect(await down.json()).toEqual({ error: 'check-unavailable' });

    const broken = await relayCheckPost(
      post(ANSWER),
      options(() => Promise.resolve(new Response(null)), { payloadOf: () => Promise.reject(new Error('x')) })
    );
    expect(broken.status).toBe(503);
  });

  it('answers 503 when the check endpoint outlasts its budget', async () => {
    const hang: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) =>
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      );
    expect((await relayCheckPost(post(ANSWER), options(hang, { timeoutMs: 10 }))).status).toBe(503);
  });

  it("passes the check endpoint's own refusal through, so the script sees it", async () => {
    const response = await relayCheckPost(
      post(ANSWER),
      options(() => Promise.resolve(Response.json({ error: 'unknown-key' }, { status: 401 })))
    );
    expect(response.status).toBe(401);
  });

  it('sends no authorization over a binding, which is its own credential', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(new Response(null)));
    await relayCheckPost(post(ANSWER), options(fetchImpl, { bearer: undefined }));
    expect(fetchImpl.mock.calls[0]![1]?.headers).not.toHaveProperty('authorization');
  });
});
