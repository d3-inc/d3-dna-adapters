import {
  ADAPTER_SET,
  DEFAULT_POLICY_TIMEOUT_MS,
  type ClientDecision,
  type RequestPayload,
  type ResponseReport,
} from '@d3-inc/d3-dna-protocol';
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from './env';
import worker, { withD3Edge } from './index';

type IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const POLICY_URL = 'https://edge-api.d3.com/v1/decision';
const REPORT_URL = 'https://edge-api.d3.com/v1/report';
const KEY = 'd3_k_' + 'a'.repeat(43) + 'AAAAAA';

const BASE_ENV: Env = {
  ...env,
  // Undo the vitest.config.ts ORIGIN stub so tests exercise the fetch() passthrough path.
  ORIGIN: undefined,
  DNA_ENDPOINT: POLICY_URL,
  DNA_API_KEY: KEY,
  DNA_TIMEOUT_MS: '1000',
  DNA_FAIL_MODE: 'open',
};

const UNCONFIGURED: Partial<Env> = { DNA_ENDPOINT: undefined, DNA_API_KEY: undefined };

afterEach(() => {
  vi.unstubAllGlobals();
});

interface FetchLog {
  policyCalls: { headers: Headers; payload: RequestPayload }[];
  originCalls: Request[];
  reportCalls: { headers: Headers; report: ResponseReport }[];
  reportStatus: number;
}

function stubOutbound(
  decision: ClientDecision | { status: number } | 'hang',
  originBody: BodyInit = 'origin says hi',
  originHeaders?: Record<string, string>
): FetchLog {
  const log: FetchLog = { policyCalls: [], originCalls: [], reportCalls: [], reportStatus: 202 };
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (request.url === REPORT_URL) {
      log.reportCalls.push({
        headers: request.headers,
        report: (await request.json()) as ResponseReport,
      });
      return new Response(null, { status: log.reportStatus });
    }

    if (request.url === POLICY_URL) {
      if (decision === 'hang') {
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        });
      }

      if ('status' in decision && !('action' in decision)) {
        return new Response('boom', { status: decision.status });
      }

      log.policyCalls.push({
        headers: request.headers,
        payload: (await request.json()) as RequestPayload,
      });
      return Response.json(decision);
    }

    log.originCalls.push(request);
    return new Response(originBody, { status: 200, headers: originHeaders });
  });
  return log;
}

function siteRequest(init?: RequestInit & { url?: string }): IncomingRequest {
  return new Request(init?.url ?? 'https://ai.d3.com/page?x=1', {
    headers: { 'user-agent': 'GPTBot/1.0', 'cf-connecting-ip': '203.0.113.7' },
    ...init,
  }) as IncomingRequest;
}

async function run(request: IncomingRequest, envOverrides?: Partial<Env>): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, { ...BASE_ENV, ...envOverrides }, ctx);
  // Byte counting resolves only once the body is drained; drain before flushing the report.
  const body = response.body ? await response.arrayBuffer() : null;
  await waitOnExecutionContext(ctx);
  return new Response(body, response);
}

describe('enforcement', () => {
  it('should proxy to origin on pass and tags the response', async () => {
    const log = stubOutbound({ action: 'pass', policyAction: 'log-only' });
    const res = await run(siteRequest());

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('origin says hi');
    expect(res.headers.get('x-d3-edge')).toBe('pass');
    expect(log.originCalls).toHaveLength(1);

    const call = log.policyCalls[0];
    expect(call.headers.get('authorization')).toBe(`Bearer ${KEY}`);
    expect(call.payload).toMatchObject({
      method: 'GET',
      url: '/page?x=1',
      host: 'ai.d3.com',
      ip: '203.0.113.7',
      adapterSet: ADAPTER_SET,
    });
    expect(call.payload.headers['user-agent']).toBe('GPTBot/1.0');
  });

  it('should return a machine-readable 403 on block without touching the origin', async () => {
    const log = stubOutbound({
      action: 'block',
      policyAction: 'block',
      ruleId: 'block:gptbot',
      verdict: { verified: false, tier: 'derived', reason: 'no-signature', identity: 'gptbot' },
    });
    const res = await run(siteRequest());

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      blocked: true,
      ruleId: 'block:gptbot',
      tier: 'derived',
      identity: 'gptbot',
    });
    expect(res.headers.get('x-d3-edge')).toBe('block');
    expect(log.originCalls).toHaveLength(0);
  });
});

describe('fail-open (§8: enforcement failure must never take the site down)', () => {
  it('should pass traffic when the policy worker errors', async () => {
    const log = stubOutbound({ status: 500 });
    const res = await run(siteRequest());
    expect(res.status).toBe(200);
    expect(res.headers.get('x-d3-edge')).toBe('fail-open');
    expect(log.originCalls).toHaveLength(1);
  });

  it('should still keep our credentials off the origin when it fails open', async () => {
    const log = stubOutbound({ status: 500 });
    // No pay cookie: a paying request never falls open, it answers 502.
    await run(
      siteRequest({
        url: 'https://ai.d3.com/page?d3pay_browser=eyJ4IjoxfQ',
        headers: { cookie: `theme=dark; __Host-d3person=${'p'.repeat(43)}` },
      })
    );

    const origin = log.originCalls[0];
    expect(origin.headers.get('cookie')).toBe('theme=dark');
    expect(origin.headers.get('d3pay-person')).toBeNull();
    expect(origin.url).toBe('https://ai.d3.com/page');
  });

  it('should forward every header but the credentials as debugHeaders only under DNA_DEBUG_LOG_RAW_PAYLOAD', async () => {
    const request = () =>
      siteRequest({
        headers: {
          'user-agent': 'GPTBot/1.0',
          'x-custom': 'v',
          cookie: 'session=secret',
          authorization: 'Bearer t',
        },
      });
    const off = stubOutbound({ action: 'pass' });
    await run(request());
    expect(off.policyCalls[0].payload.debugHeaders).toBeUndefined();

    const on = stubOutbound({ action: 'pass' });
    await run(request(), { DNA_DEBUG_LOG_RAW_PAYLOAD: 'true' });
    const sent = on.policyCalls[0].payload;
    expect(sent.debugHeaders).toEqual({ 'user-agent': 'GPTBot/1.0', 'x-custom': 'v' });
    // Revision 2 forwards the rest either way, but never `authorization` nor the raw `Cookie`.
    expect(Object.keys(sent.headers).sort()).toEqual(['user-agent', 'x-custom']);
    expect(sent.cookies).toEqual({ session: 'secret' });
  });

  it('should pass traffic when the policy call exceeds its timeout budget', async () => {
    const log = stubOutbound('hang');
    const res = await run(siteRequest(), { DNA_TIMEOUT_MS: '20' });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-d3-edge')).toBe('fail-open');
    expect(log.originCalls).toHaveLength(1);
  });

  it('should fall back to the shared default budget when the var is unusable', async () => {
    const log = stubOutbound('hang');
    const started = Date.now();
    const res = await run(siteRequest(), { DNA_TIMEOUT_MS: 'soon' });
    const elapsed = Date.now() - started;

    // Bounded both ways: a lower bound alone also passes on a fallback that
    // picked up some other, larger budget — the payment one is 5x this.
    expect(elapsed).toBeGreaterThanOrEqual(DEFAULT_POLICY_TIMEOUT_MS * 0.8);
    expect(elapsed).toBeLessThan(DEFAULT_POLICY_TIMEOUT_MS * 2);
    expect(res.headers.get('x-d3-edge')).toBe('fail-open');
    expect(log.originCalls).toHaveLength(1);
  });

  it('should pass traffic on an invalid decision body', async () => {
    stubOutbound({ action: 'self-destruct' } as unknown as ClientDecision);
    const res = await run(siteRequest());
    expect(res.headers.get('x-d3-edge')).toBe('fail-open');
  });

  it('should block instead when the site opted into fail-closed', async () => {
    const log = stubOutbound({ status: 500 });
    const res = await run(siteRequest(), { DNA_FAIL_MODE: 'closed' });
    expect(res.status).toBe(403);
    expect(res.headers.get('x-d3-edge')).toBe('fail-closed');
    expect(log.originCalls).toHaveLength(0);
  });
});

describe('certificate challenges', () => {
  it('sends an ACME challenge to the origin without asking for a decision', async () => {
    const log = stubOutbound({ action: 'block' });
    const res = await run(siteRequest({ url: 'https://ai.d3.com/.well-known/acme-challenge/tok3n' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-d3-edge')).toBe('pass');
    expect(log.policyCalls).toHaveLength(0);
    expect(log.originCalls).toHaveLength(1);
  });

  it('still decides on a path that merely mentions the challenge directory', async () => {
    const log = stubOutbound({ action: 'block' });
    const res = await run(siteRequest({ url: 'https://ai.d3.com/blog/.well-known/acme-challenge/' }));
    expect(res.status).toBe(403);
    expect(log.policyCalls).toHaveLength(1);
  });
});

describe('passthrough + proxying modes', () => {
  it('should pass straight through when nothing is configured (M0 mode)', async () => {
    const log = stubOutbound({ action: 'pass' });
    const res = await run(siteRequest(), UNCONFIGURED);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-d3-edge')).toBe('disabled');
    expect(log.policyCalls).toHaveLength(0);
    expect(log.originCalls).toHaveLength(1);
  });

  it('should call the default endpoint when DNA_API_KEY is the only setting', async () => {
    const log = stubOutbound({ action: 'pass' });
    const res = await run(siteRequest(), { DNA_ENDPOINT: undefined });
    expect(res.headers.get('x-d3-edge')).toBe('pass');
    expect(log.policyCalls[0].headers.get('authorization')).toBe(`Bearer ${KEY}`);
  });

  it('should pass straight through under an unquoted DNA_ENABLED = false', async () => {
    const log = stubOutbound({ action: 'block' });
    const res = await run(siteRequest(), { DNA_ENABLED: false as unknown as string });
    expect(res.headers.get('x-d3-edge')).toBe('disabled');
    expect(log.policyCalls).toHaveLength(0);
  });

  it('should pass straight through under DNA_ENABLED=false, key and endpoint set', async () => {
    const log = stubOutbound({ action: 'block' });
    const res = await run(siteRequest(), { DNA_ENABLED: 'false' });
    expect(res.headers.get('x-d3-edge')).toBe('disabled');
    expect(log.policyCalls).toHaveLength(0);
  });

  it('should rewrite to ORIGIN_URL when configured, preserving path and query', async () => {
    const log = stubOutbound({ action: 'pass' });
    await run(siteRequest(), { ORIGIN_URL: 'https://origin.internal:8443' });
    expect(log.originCalls[0].url).toBe('https://origin.internal:8443/page?x=1');
  });

  it('should forward to the ORIGIN service binding when the origin is a Worker', async () => {
    const log = stubOutbound({ action: 'pass' });
    const bindingCalls: Request[] = [];
    const ORIGIN = {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        bindingCalls.push(input instanceof Request ? input : new Request(input, init));
        return new Response('worker origin', { status: 200 });
      },
    } as unknown as Fetcher;

    const res = await run(siteRequest(), { ORIGIN, ORIGIN_URL: 'https://ignored.example' });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('worker origin');
    expect(res.headers.get('x-d3-edge')).toBe('pass');
    expect(bindingCalls).toHaveLength(1);
    expect(bindingCalls[0].url).toBe('https://ai.d3.com/page?x=1');
    expect(log.originCalls).toHaveLength(0);
  });
});

// An install configured before the DNA_ names must behave exactly as it did.
describe('legacy setting names', () => {
  const LEGACY: Partial<Env> = {
    ...UNCONFIGURED,
    DNA_TIMEOUT_MS: undefined,
    DNA_FAIL_MODE: undefined,
    POLICY_WORKER_URL: POLICY_URL,
    POLICY_ADAPTER_KEY: KEY,
  };

  it('should enforce with POLICY_WORKER_URL and POLICY_ADAPTER_KEY', async () => {
    const log = stubOutbound({ action: 'pass' });
    const res = await run(siteRequest(), LEGACY);
    expect(res.headers.get('x-d3-edge')).toBe('pass');
    expect(log.policyCalls[0].headers.get('authorization')).toBe(`Bearer ${KEY}`);
  });

  it('should still read POLICY_SHARED_SECRET as the key', async () => {
    const log = stubOutbound({ action: 'pass' });
    await run(siteRequest(), { ...LEGACY, POLICY_ADAPTER_KEY: undefined, POLICY_SHARED_SECRET: KEY });
    expect(log.policyCalls[0].headers.get('authorization')).toBe(`Bearer ${KEY}`);
  });

  it('should stay a passthrough on a legacy key with POLICY_WORKER_URL unset', async () => {
    const log = stubOutbound({ action: 'block' });
    const res = await run(siteRequest(), { ...LEGACY, POLICY_WORKER_URL: undefined });
    expect(res.headers.get('x-d3-edge')).toBe('disabled');
    expect(log.policyCalls).toHaveLength(0);
  });

  it('should honor FAIL_MODE=closed', async () => {
    stubOutbound({ status: 500 });
    const res = await run(siteRequest(), { ...LEGACY, FAIL_MODE: 'closed' });
    expect(res.status).toBe(403);
    expect(res.headers.get('x-d3-edge')).toBe('fail-closed');
  });

  it('should honor an unquoted TOML number, which wrangler passes as a number', async () => {
    stubOutbound('hang');
    const start = Date.now();
    const res = await run(siteRequest(), { ...LEGACY, POLICY_TIMEOUT_MS: 20 as unknown as string });
    expect(res.headers.get('x-d3-edge')).toBe('fail-open');
    expect(Date.now() - start).toBeLessThan(DEFAULT_POLICY_TIMEOUT_MS / 2);
  });

  it('should honor POLICY_TIMEOUT_MS', async () => {
    stubOutbound('hang');
    const start = Date.now();
    const res = await run(siteRequest(), { ...LEGACY, POLICY_TIMEOUT_MS: '20' });
    expect(res.headers.get('x-d3-edge')).toBe('fail-open');
    expect(Date.now() - start).toBeLessThan(DEFAULT_POLICY_TIMEOUT_MS / 2);
  });

  it('should let DNA_FAIL_MODE win over FAIL_MODE when both are set', async () => {
    stubOutbound({ status: 500 });
    const res = await run(siteRequest(), { ...LEGACY, DNA_FAIL_MODE: 'closed', FAIL_MODE: 'open' });
    expect(res.headers.get('x-d3-edge')).toBe('fail-closed');
  });
});

describe('the fleet deployment: a service binding, no URL, no key (ADR 0029 decision 1)', () => {
  /** A stand-in for the policy worker's `Fleet` entrypoint, recording what reached it. */
  function fleetBinding(decision: ClientDecision): { env: Partial<Env>; calls: Request[] } {
    const calls: Request[] = [];
    const POLICY_WORKER = {
      async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
        const request = input instanceof Request ? input : new Request(input, init);
        calls.push(request);
        return new URL(request.url).pathname === '/v1/report'
          ? new Response(null, { status: 202 })
          : Response.json(decision);
      },
    } as unknown as Fetcher;
    return { env: { POLICY_WORKER, ...UNCONFIGURED }, calls };
  }

  const pathOf = (request: Request) => new URL(request.url).pathname;

  it('should ask over the binding with no bearer and enforce the answer', async () => {
    const outbound = stubOutbound({ action: 'pass', policyAction: 'log-only' });
    const fleet = fleetBinding({ action: 'block', policyAction: 'block', ruleId: 'block:all' });

    const res = await run(siteRequest(), fleet.env);

    expect(res.status).toBe(403);
    expect(outbound.policyCalls).toHaveLength(0);
    const decision = fleet.calls.find((r) => pathOf(r) === '/v1/decision');
    expect(decision).toBeDefined();
    expect(decision!.headers.has('authorization')).toBe(false);
    expect(new URL(decision!.url).hostname).toBe('policy-worker.invalid');
    expect(((await decision!.json()) as RequestPayload).host).toBe('ai.d3.com');
  });

  it('should report over the same binding, also without a bearer', async () => {
    const outbound = stubOutbound({ action: 'pass', policyAction: 'log-only' });
    const fleet = fleetBinding({ action: 'pass', policyAction: 'log-only' });

    await run(siteRequest(), fleet.env);

    expect(outbound.reportCalls).toHaveLength(0);
    const report = fleet.calls.find((r) => pathOf(r) === '/v1/report');
    expect(report).toBeDefined();
    expect(report!.headers.has('authorization')).toBe(false);
    expect(((await report!.json()) as ResponseReport).mode).toBe('pass');
  });

  it('should honor a legacy FAIL_MODE=closed over the binding, which has no POLICY_WORKER_URL', async () => {
    stubOutbound({ action: 'pass' });
    const failing = {
      fetch: async () => new Response('down', { status: 500 }),
    } as unknown as Fetcher;
    const res = await run(siteRequest(), {
      POLICY_WORKER: failing,
      ...UNCONFIGURED,
      DNA_FAIL_MODE: undefined,
      FAIL_MODE: 'closed',
    });
    expect(res.status).toBe(403);
    expect(res.headers.get('x-d3-edge')).toBe('fail-closed');
  });

  it('should prefer the binding over a URL and key left in the config', async () => {
    const outbound = stubOutbound({ action: 'pass', policyAction: 'log-only' });
    const fleet = fleetBinding({ action: 'pass', policyAction: 'log-only' });

    await run(siteRequest(), { ...fleet.env, DNA_ENDPOINT: POLICY_URL, DNA_API_KEY: KEY });

    expect(outbound.policyCalls).toHaveLength(0);
    expect(fleet.calls.some((r) => pathOf(r) === '/v1/decision')).toBe(true);
  });
});

describe('outcome reports', () => {
  it('should report a pass with the origin status and the decision requestId', async () => {
    const log = stubOutbound({ action: 'pass' });
    await run(siteRequest());

    expect(log.reportCalls).toHaveLength(1);
    const { headers, report } = log.reportCalls[0];
    expect(headers.get('authorization')).toBe(`Bearer ${KEY}`);
    expect(report).toMatchObject({
      requestId: log.policyCalls[0].payload.requestId,
      host: 'ai.d3.com',
      path: '/page',
      method: 'GET',
      mode: 'pass',
      status: 200,
    });
    expect(report.originLatencyMs).toBeGreaterThanOrEqual(0);
  });

  it('should report the declared Content-Length without touching the body', async () => {
    const log = stubOutbound({ action: 'pass' }, 'origin says hi', { 'content-length': '14' });
    await run(siteRequest());
    expect(log.reportCalls[0].report.contentLength).toBe(14);
  });

  it('should count body bytes when the origin streams without Content-Length', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('chunk-one|'));
        controller.enqueue(new TextEncoder().encode('chunk-two'));
        controller.close();
      },
    });
    const log = stubOutbound({ action: 'pass' }, stream);

    const res = await run(siteRequest());

    expect(await res.text()).toBe('chunk-one|chunk-two');
    expect(log.reportCalls[0].report.contentLength).toBe('chunk-one|chunk-two'.length);
  });

  it('should report a block without origin latency', async () => {
    const log = stubOutbound({ action: 'block', policyAction: 'block' });
    await run(siteRequest());

    expect(log.reportCalls[0].report).toMatchObject({ mode: 'block', status: 403 });
    expect(log.reportCalls[0].report.originLatencyMs).toBeUndefined();
  });

  it('tags a 200 payment instruction as a stub, not as the money gate failing closed', async () => {
    const log = stubOutbound({
      action: 'pass',
      payment: {
        status: 200,
        headers: { 'www-authenticate': 'Payment realm="ai.d3.com"' },
        body: '{"how":"x"}',
      },
    });
    const res = await run(siteRequest());
    expect(res.status).toBe(200);
    expect(res.headers.get('x-d3-edge')).toBe('payment-stub');
    expect(await res.text()).toBe('{"how":"x"}');
    expect(log.reportCalls[0].report).toMatchObject({ mode: 'payment-stub', status: 200 });
    expect(log.reportCalls[0].report.answer?.body).toBe('{"how":"x"}');
  });

  it('should carry the answer it built, whole, and never the origin page', async () => {
    const block = stubOutbound({ action: 'block', policyAction: 'block', ruleId: 'block:gptbot' });
    const res = await run(siteRequest());
    expect(await res.text()).toContain('"blocked":true');
    expect(block.reportCalls[0].report.answer).toEqual({
      headers: { 'content-type': 'application/json; charset=utf-8', 'x-d3-edge': 'block' },
      body: JSON.stringify({ blocked: true, ruleId: 'block:gptbot', tier: undefined, identity: undefined }),
    });

    const challenge = stubOutbound({
      action: 'pass',
      payment: {
        status: 402,
        headers: { 'www-authenticate': 'Payment realm="ai.d3.com"' },
        body: '{"error":"payment_required"}',
      },
    });
    await run(siteRequest());
    expect(challenge.reportCalls[0].report).toMatchObject({
      mode: 'payment-required',
      answer: {
        headers: { 'www-authenticate': 'Payment realm="ai.d3.com"', 'x-d3-edge': 'payment-required' },
        body: '{"error":"payment_required"}',
      },
    });

    const redirect = stubOutbound({
      action: 'pass',
      payment: { status: 302, headers: { location: 'https://pay.example/pay' } },
    });
    await run(siteRequest());
    expect(redirect.reportCalls[0].report.answer?.headers.location).toBe('https://pay.example/pay');
    expect(redirect.reportCalls[0].report.answer?.body).toBeUndefined();

    const passed = stubOutbound({ action: 'pass' });
    await run(siteRequest());
    expect(passed.reportCalls[0].report.answer).toBeUndefined();
  });

  it('should report fail-open and fail-closed outcomes', async () => {
    let log = stubOutbound({ status: 500 });
    await run(siteRequest());
    expect(log.reportCalls[0].report).toMatchObject({ mode: 'fail-open', status: 200 });

    log = stubOutbound({ status: 500 });
    await run(siteRequest(), { DNA_FAIL_MODE: 'closed' });
    expect(log.reportCalls[0].report).toMatchObject({ mode: 'fail-closed', status: 403 });
  });

  it('should not let a failing report endpoint affect the client response', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = stubOutbound({ action: 'pass' });
    log.reportStatus = 500;

    const res = await run(siteRequest());
    expect(res.status).toBe(200);
    expect(res.headers.get('x-d3-edge')).toBe('pass');
    errorSpy.mockRestore();
  });

  it('should send no report in disabled mode', async () => {
    const log = stubOutbound({ action: 'pass' });
    await run(siteRequest(), UNCONFIGURED);
    expect(log.reportCalls).toHaveLength(0);
  });
});

describe('withD3Edge (wrapping an existing worker)', () => {
  function wrappedSite() {
    const siteCalls: Request[] = [];
    const site = withD3Edge<Env>({
      async fetch(request) {
        siteCalls.push(request as Request);
        return new Response('site says hi', { status: 201 });
      },
      async scheduled() {},
    });
    return { site, siteCalls };
  }

  async function runWrapped(site: ExportedHandler<Env>, envOverrides?: Partial<Env>): Promise<Response> {
    const ctx = createExecutionContext();
    const response = await site.fetch!(siteRequest(), { ...BASE_ENV, ...envOverrides }, ctx);
    const body = response.body ? await response.arrayBuffer() : null;
    await waitOnExecutionContext(ctx);
    return new Response(body, response);
  }

  it('should invoke the wrapped fetch on pass and tag the response', async () => {
    const log = stubOutbound({ action: 'pass' });
    const { site, siteCalls } = wrappedSite();

    const res = await runWrapped(site);

    expect(res.status).toBe(201);
    expect(await res.text()).toBe('site says hi');
    expect(res.headers.get('x-d3-edge')).toBe('pass');
    expect(siteCalls).toHaveLength(1);
    expect(log.originCalls).toHaveLength(0);
    expect(log.reportCalls[0].report).toMatchObject({ mode: 'pass', status: 201 });
  });

  it('should block without invoking the wrapped fetch', async () => {
    stubOutbound({ action: 'block', policyAction: 'block' });
    const { site, siteCalls } = wrappedSite();

    const res = await runWrapped(site);

    expect(res.status).toBe(403);
    expect(res.headers.get('x-d3-edge')).toBe('block');
    expect(siteCalls).toHaveLength(0);
  });

  it('should fall through to the wrapped fetch on fail-open and when disabled', async () => {
    stubOutbound({ status: 500 });
    const { site, siteCalls } = wrappedSite();
    expect((await runWrapped(site)).headers.get('x-d3-edge')).toBe('fail-open');

    stubOutbound({ action: 'pass' });
    expect((await runWrapped(site, UNCONFIGURED)).headers.get('x-d3-edge')).toBe('disabled');
    expect(siteCalls).toHaveLength(2);
  });

  it('should preserve non-fetch handlers and reject a handler without fetch', () => {
    const { site } = wrappedSite();
    expect(site.scheduled).toBeTypeOf('function');
    expect(() => withD3Edge<Env>({})).toThrow(/no fetch/);
  });
});

describe('paid routes', () => {
  const CRLF = String.fromCharCode(13, 10);

  const paying = () =>
    siteRequest({
      headers: {
        'user-agent': 'GPTBot/1.0',
        'cf-connecting-ip': '203.0.113.7',
        'payment-signature': 'eyJ4NDAyVmVyc2lvbiI6Mn0=',
      },
    });

  it('never reaches the origin for a status it was handed', async () => {
    // The money gate fails closed where enforcement fails open.
    const log = stubOutbound({
      action: 'pass',
      payment: { status: 402, headers: { 'payment-required': 'eyJ4IjoxfQ==' } },
    });

    const res = await run(siteRequest());

    expect(res.status).toBe(402);
    expect(res.headers.get('payment-required')).toBe('eyJ4IjoxfQ==');
    expect(res.headers.get('x-d3-edge')).toBe('payment-required');
    expect(log.originCalls).toHaveLength(0);
  });

  it('tags a fail-closed money answer apart from an unpaid one', async () => {
    const log = stubOutbound({ action: 'pass', payment: { status: 502, body: '{"error":"x"}' } });

    const res = await run(siteRequest());

    expect(res.status).toBe(502);
    expect(res.headers.get('x-d3-edge')).toBe('fail-closed');
    expect(log.originCalls).toHaveLength(0);
  });

  it('carries a receipt onto the origin response when nothing terminates', async () => {
    const log = stubOutbound({ action: 'pass', payment: { headers: { 'payment-response': 'abc' } } });

    const res = await run(siteRequest());

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('origin says hi');
    expect(res.headers.get('payment-response')).toBe('abc');
    expect(res.headers.get('x-d3-edge')).toBe('pass');
    expect(log.originCalls).toHaveLength(1);
  });

  it('drops a header value that could inject into the response', async () => {
    // Built from provider and tenant-authored input, so the adapter re-checks
    // what it was handed rather than trusting the worker's guard alone.
    stubOutbound({
      action: 'pass',
      payment: {
        status: 402,
        headers: { 'payment-required': 'ok', 'x-bad': `a${CRLF}Set-Cookie: b` },
      },
    });

    const res = await run(siteRequest());

    expect(res.headers.get('payment-required')).toBe('ok');
    expect(res.headers.get('x-bad')).toBeNull();
  });

  it('forwards the payment header to the worker under a cap', async () => {
    const log = stubOutbound({ action: 'pass', policyAction: 'log-only' });

    await run(paying());

    expect(log.policyCalls[0].payload.headers['payment-signature']).toBe('eyJ4NDAyVmVyc2lvbiI6Mn0=');
  });

  it('drops an oversized payment header before anything decodes it', async () => {
    const log = stubOutbound({ action: 'pass', policyAction: 'log-only' });

    await run(
      siteRequest({
        headers: { 'user-agent': 'GPTBot/1.0', 'payment-signature': 'a'.repeat(4097) },
      })
    );

    expect(log.policyCalls[0].payload.headers['payment-signature']).toBeUndefined();
  });

  it('waits longer for a request that is presenting a payment', async () => {
    // The short budget would abort a settle that is, by construction, slow.
    const log = stubOutbound('hang');
    const started = Date.now();
    await run(paying(), { DNA_TIMEOUT_MS: '30', DNA_PAYMENT_TIMEOUT_MS: '250' });
    const paid = Date.now() - started;

    const ordinary = Date.now();
    await run(siteRequest(), { DNA_TIMEOUT_MS: '30', DNA_PAYMENT_TIMEOUT_MS: '250' });
    const free = Date.now() - ordinary;

    expect(paid).toBeGreaterThan(free);
    expect(log.originCalls.length).toBeGreaterThan(0);
  });
});

// extractPayload / sha256ContentDigest tests live in
// packages/protocol/src/adapter/extract.spec.ts.

describe('DNA at the adapter', () => {
  const PAY_HEADERS = { 'payment-authorization': 'Payment ' + 'a'.repeat(43) };
  const SESSION = 'b'.repeat(43);

  it('classifies a 3xx payment instruction as payment-redirect with no JSON type', async () => {
    const log = stubOutbound({
      action: 'pass',
      payment: {
        status: 302,
        headers: {
          location: 'https://pay.example/?back=x',
          link: '<https://pay.example/?back=x>; rel="payment"',
        },
      },
    });
    const response = await run(siteRequest({ headers: { accept: 'text/html' } }));
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://pay.example/?back=x');
    expect(response.headers.get('content-type')).toBeNull();
    expect(response.headers.get('x-d3-edge')).toBe('payment-redirect');
    expect(log.originCalls).toHaveLength(0);
    expect(log.reportCalls[0]?.report.mode).toBe('payment-redirect');
  });

  it('strips every payment header before the origin fetch and keeps the receipt on the response', async () => {
    const log = stubOutbound({ action: 'pass', payment: { headers: { 'payment-receipt': 'abc' } } });
    const response = await run(
      siteRequest({ headers: { ...PAY_HEADERS, 'payment-signature': 'sig', 'user-agent': 'agent' } })
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('payment-receipt')).toBe('abc');
    const origin = log.originCalls[0]!;
    expect(origin.headers.get('payment-authorization')).toBeNull();
    expect(origin.headers.get('payment-signature')).toBeNull();
    expect(origin.headers.get('user-agent')).toBe('agent');
    expect(log.policyCalls[0]?.payload.headers['payment-authorization']).toBe(
      PAY_HEADERS['payment-authorization']
    );
  });

  it('forwards only our cookie, strips it before the origin, and appends the Set-Cookie a redemption returns', async () => {
    const log = stubOutbound({
      action: 'pass',
      payment: {
        headers: { 'payment-receipt': 'abc', 'set-cookie': '__Host-d3pay=new; Path=/; Secure; HttpOnly' },
      },
    });
    const response = await run(siteRequest({ headers: { cookie: `theme=dark; __Host-d3pay=${SESSION}` } }));
    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie()).toContain('__Host-d3pay=new; Path=/; Secure; HttpOnly');
    const origin = log.originCalls[0]!;
    expect(origin.headers.get('cookie')).toBe('theme=dark');
    const forwarded = log.policyCalls[0]?.payload.headers ?? {};
    expect(forwarded['d3pay-session']).toBe(SESSION);
    expect(forwarded.cookie).toBeUndefined();
  });

  it('fails closed with 502 payment_unavailable when the decision call throws and a payment header is present', async () => {
    const log = stubOutbound('hang');
    const response = await run(siteRequest({ headers: PAY_HEADERS }), {
      DNA_PAYMENT_TIMEOUT_MS: '20',
      DNA_FAIL_MODE: 'open',
    });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'payment_unavailable' });
    expect(response.headers.get('x-d3-edge')).toBe('fail-closed');
    expect(log.originCalls).toHaveLength(0);
  });

  it('treats a handoff on the URL as paying: the payment budget, and 502 rather than a block when it overruns', async () => {
    const handoff = `${'a'.repeat(22)}.${'b'.repeat(43)}`;
    const log = stubOutbound('hang');
    const response = await run(siteRequest({ url: `https://ai.d3.com/premium?d3pay_handoff=${handoff}` }), {
      DNA_PAYMENT_TIMEOUT_MS: '20',
      DNA_TIMEOUT_MS: '5000',
      DNA_FAIL_MODE: 'closed',
    });
    // The short budget would have been 5s here; it answered on the 20ms paying one.
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'payment_unavailable' });
    expect(log.originCalls).toHaveLength(0);
  });

  it('still fails open without a payment header', async () => {
    const log = stubOutbound('hang');
    const response = await run(siteRequest(), { DNA_TIMEOUT_MS: '20', DNA_FAIL_MODE: 'open' });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-d3-edge')).toBe('fail-open');
    expect(log.originCalls).toHaveLength(1);
  });
});

describe('forwarding and MCP carriage (ADR 0081)', () => {
  const mcpCall = (params: Record<string, unknown>, method = 'tools/call', host = 'mcp.example') =>
    new Request(`https://${host}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'Agent/1' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 42, method, params }),
    }) as IncomingRequest;

  it('declares revision 3, forwards every header and cookie, and keeps back what the site lists', async () => {
    const log = stubOutbound({ action: 'pass' });
    await run(
      siteRequest({
        headers: {
          'user-agent': 'GPTBot/1.0',
          'x-partner': 'acme',
          'x-api-key': 'k',
          cookie: 'plan=pro; sid=s',
        },
      }),
      { DNA_EXCLUDE_HEADERS: 'X-Api-Key', DNA_EXCLUDE_COOKIES: 'sid' }
    );
    const sent = log.policyCalls[0].payload;
    expect(sent.adapterSet).toBe(ADAPTER_SET);
    expect(ADAPTER_SET).toBe(3);
    expect(sent.headers['x-partner']).toBe('acme');
    expect(sent.headers['x-api-key']).toBeUndefined();
    expect(sent.cookies).toEqual({ plan: 'pro' });
    expect(sent.excluded).toEqual({ headers: ['x-api-key'], cookies: ['sid'] });
  });

  it("lifts a call's payment for the decision and never lets it reach the origin", async () => {
    const log = stubOutbound({ action: 'pass' }, '{}', { 'content-type': 'application/json' });
    await run(mcpCall({ name: 'get_report', _meta: { 'dna.d3.com/key': 'dna_k_1' } }));

    const sent = log.policyCalls[0].payload;
    expect(sent.mcp).toEqual({ method: 'tools/call', tool: 'get_report', source: 'body' });
    expect(sent.headers['payment-authorization']).toBe('Payment dna_k_1');

    const origin = log.originCalls[0];
    expect(origin.headers.get('payment-authorization')).toBeNull();
    expect(await origin.json()).toEqual({
      jsonrpc: '2.0',
      id: 42,
      method: 'tools/call',
      params: { name: 'get_report' },
    });
  });

  it('refuses a call too large to read that names a credential, before deciding or reaching the origin', async () => {
    const log = stubOutbound({ action: 'pass' });
    const res = await run(
      mcpCall({ name: 'get_report', pad: 'x'.repeat(1_048_576), _meta: { 'dna.d3.com/key': 'dna_k_1' } })
    );
    expect(res.status).toBe(413);
    expect(res.headers.get('x-d3-edge')).toBe('fail-closed');
    expect(log.policyCalls).toHaveLength(0);
    expect(log.originCalls).toHaveLength(0);
  });

  it('gives a lifted key past its cap no payment budget, so a failed decision falls open without it', async () => {
    const log = stubOutbound({ status: 500 }, '{}', { 'content-type': 'application/json' });
    const res = await run(mcpCall({ name: 'get_report', _meta: { 'dna.d3.com/key': 'k'.repeat(5000) } }));
    expect(res.headers.get('x-d3-edge')).toBe('fail-open');
    expect(((await log.originCalls[0].json()) as { params: unknown }).params).toEqual({ name: 'get_report' });
  });

  it('keeps a lifted key from DNA when the site excludes the header', async () => {
    const log = stubOutbound({ action: 'pass' }, '{}', { 'content-type': 'application/json' });
    await run(mcpCall({ name: 'get_report', _meta: { 'dna.d3.com/key': 'dna_k_1' } }), {
      DNA_EXCLUDE_HEADERS: 'payment-authorization',
    });
    expect(log.policyCalls[0].payload.headers['payment-authorization']).toBeUndefined();
    expect(((await log.originCalls[0].json()) as { params: unknown }).params).toEqual({ name: 'get_report' });
  });

  it('keeps a receipt out of shared caches when only the result carries it', async () => {
    stubOutbound(
      { action: 'pass', payment: { meta: { 'dna.d3.com/receipt': { status: 'success' } } } },
      JSON.stringify({ jsonrpc: '2.0', id: 42, result: {} }),
      { 'content-type': 'application/json', 'cache-control': 'public, max-age=300' }
    );
    const res = await run(mcpCall({ name: 'get_report' }));
    expect(res.headers.get('cache-control')).toBe('private, max-age=300');
  });

  it("adds the receipt to the origin's JSON result", async () => {
    const meta = { 'dna.d3.com/receipt': { status: 'success', charged: 1000 } };
    stubOutbound(
      { action: 'pass', payment: { headers: { 'payment-receipt': 'e30=' }, meta } },
      JSON.stringify({ jsonrpc: '2.0', id: 42, result: { content: [] } }),
      { 'content-type': 'application/json' }
    );
    const res = await run(mcpCall({ name: 'get_report' }));
    expect(res.headers.get('payment-receipt')).toBe('e30=');
    expect(await res.json()).toEqual({ jsonrpc: '2.0', id: 42, result: { content: [], _meta: meta } });
  });

  it("answers a json-rpc instruction itself, with the call's id", async () => {
    const result = { isError: true, structuredContent: { x402Version: 2 } };
    const log = stubOutbound({
      action: 'pass',
      payment: { status: 402, bodyKind: 'json-rpc', body: JSON.stringify(result) },
    });
    const res = await run(mcpCall({ name: 'get_report' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-d3-edge')).toBe('payment-required');
    expect(await res.json()).toEqual({ jsonrpc: '2.0', id: 42, result });
    expect(log.originCalls).toHaveLength(0);
  });

  it('offers the key argument on tools/list once a decision for the host says the site turned it on', async () => {
    type ToolList = { result: { tools: { inputSchema?: { properties?: object } }[] } };
    const host = 'key-argument.example';
    const tools = JSON.stringify({ jsonrpc: '2.0', id: 42, result: { tools: [{ name: 'a' }] } });
    stubOutbound({ action: 'pass', mcpKeyArgument: true }, tools, { 'content-type': 'application/json' });
    const listed = await run(mcpCall({}, 'tools/list', host));
    expect(((await listed.json()) as ToolList).result.tools[0].inputSchema?.properties).toHaveProperty(
      'dna_account_key'
    );

    // The argument is the payment now, and leaves the call before the origin.
    const log = stubOutbound({ action: 'pass' }, '{}', { 'content-type': 'application/json' });
    await run(mcpCall({ name: 'a', arguments: { q: 'x', dna_account_key: 'dna_k_2' } }, 'tools/call', host));
    expect(log.policyCalls[0].payload.headers['payment-authorization']).toBe('Payment dna_k_2');
    expect(
      ((await log.originCalls[0].json()) as { params: { arguments: unknown } }).params.arguments
    ).toEqual({ q: 'x' });

    stubOutbound({ action: 'pass', mcpKeyArgument: false }, tools, { 'content-type': 'application/json' });
    const off = await run(mcpCall({}, 'tools/list', host));
    expect(((await off.json()) as ToolList).result.tools[0]).toEqual({ name: 'a' });
  });

  it('takes the key argument out of the call even on an isolate that has not heard the site switch', async () => {
    const log = stubOutbound({ action: 'pass' }, '{}', { 'content-type': 'application/json' });
    await run(
      mcpCall(
        { name: 'a', arguments: { q: 'x', dna_account_key: 'dna_k_cold' } },
        'tools/call',
        'cold.example'
      )
    );
    expect(log.policyCalls[0].payload.headers['payment-authorization']).toBe('Payment dna_k_cold');
    const sent = (await log.originCalls[0].json()) as { params: { arguments: unknown } };
    expect(sent.params.arguments).toEqual({ q: 'x' });
  });

  it("keeps Cloudflare's own request facts on a call whose body it rewrote", async () => {
    const log = stubOutbound({ action: 'pass' }, '{}', { 'content-type': 'application/json' });
    const paid = new Request('https://mcp.example/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { _meta: { 'dna.d3.com/key': 'k' } },
      }),
      cf: { country: 'DE' },
    } as RequestInit) as IncomingRequest;
    const wrapped = withD3Edge<Env>({
      fetch: async (request) => {
        const facts = (request as IncomingRequest).cf;
        return Response.json({ country: facts?.country ?? null });
      },
    });
    const ctx = createExecutionContext();
    const res = await wrapped.fetch!(paid, BASE_ENV, ctx);
    const body = await res.json();
    await waitOnExecutionContext(ctx);
    expect(body).toEqual({ country: 'DE' });
    expect(log.policyCalls[0].payload.headers['payment-authorization']).toBe('Payment k');
  });

  it('never falls open on a payment lifted from the body', async () => {
    stubOutbound('hang');
    const res = await run(mcpCall({ name: 'a', _meta: { 'dna.d3.com/key': 'k' } }), {
      DNA_TIMEOUT_MS: '20',
      DNA_PAYMENT_TIMEOUT_MS: '20',
    });
    expect(res.status).toBe(502);
    expect(res.headers.get('x-d3-edge')).toBe('fail-closed');
  });
});
