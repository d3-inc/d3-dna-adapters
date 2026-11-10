import { FORWARDS_ALL_SINCE, type ClientDecision, type ResponseReport } from '@d3-inc/d3-dna-protocol';
import { describe, expect, it } from 'vitest';
import type { D3MiddlewareConfig } from './env';
import { createD3Middleware, type MiddlewareDeps } from './middleware';

const URL = 'https://edge-api.d3.com/v1/decision';
const REPORT_URL = 'https://edge-api.d3.com/v1/report';
const KEY = 'd3_k_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaAAAAAA';
const BASE_CONFIG: D3MiddlewareConfig = { endpoint: URL, apiKey: KEY, timeoutMs: 1000 };

interface Harness {
  deps: MiddlewareDeps;
  nextCalls: Array<{ headers?: HeadersInit; request?: { headers?: Headers } }>;
  policyCalls: Array<{ headers: Record<string, string>; body: unknown }>;
  reportCalls: Array<{ headers: Record<string, string>; report: ResponseReport }>;
  flushReports: () => Promise<void>;
}

// Fakes the Vercel seams so the middleware runs in plain Node. `hang` answers
// only when the middleware's own budget aborts the call.
function harness(decision: ClientDecision | { status: number } | 'throw' | 'hang'): Harness {
  const nextCalls: Harness['nextCalls'] = [];
  const policyCalls: Harness['policyCalls'] = [];
  const reportCalls: Harness['reportCalls'] = [];
  const pendingReports: Promise<unknown>[] = [];
  const deps: MiddlewareDeps = {
    next: (init) => {
      nextCalls.push(init ?? {});
      return new Response(null, { status: 200, headers: init?.headers });
    },
    ipAddress: () => '203.0.113.7',
    waitUntil: (promise) => {
      pendingReports.push(promise);
    },
    fetchImpl: (async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url) === REPORT_URL) {
        reportCalls.push({
          headers: (init?.headers as Record<string, string>) ?? {},
          report: JSON.parse(init?.body as string) as ResponseReport,
        });
        return new Response(null, { status: 202 });
      }

      policyCalls.push({
        headers: (init?.headers as Record<string, string>) ?? {},
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      });
      if (decision === 'throw') throw new Error('boom');

      if (decision === 'hang') {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        });
      }

      if ('status' in decision && !('action' in decision)) {
        return new Response('boom', { status: decision.status });
      }

      return Response.json(decision);
    }) as typeof fetch,
  };
  return {
    deps,
    nextCalls,
    policyCalls,
    reportCalls,
    flushReports: async () => void (await Promise.all(pendingReports)),
  };
}

function siteRequest(url = 'https://ai.d3.com/page?x=1') {
  return new Request(url, { headers: { 'user-agent': 'GPTBot/1.0' } });
}

describe('createD3Middleware', () => {
  it('passes to the site and tags the response on a pass decision', async () => {
    const h = harness({ action: 'pass', policyAction: 'log-only' });
    const mw = createD3Middleware(BASE_CONFIG, h.deps);
    const res = await mw(siteRequest());

    expect(res.status).toBe(200);
    expect(res.headers.get('x-d3-edge')).toBe('pass');
    expect(h.nextCalls).toHaveLength(1);

    expect(h.policyCalls[0].headers.authorization).toBe(`Bearer ${KEY}`);
    expect(h.policyCalls[0].headers['dna-adapter']).toBe('vercel-middleware:0.0.0-test');
    expect(h.policyCalls[0].body).toMatchObject({
      method: 'GET',
      url: '/page?x=1',
      host: 'ai.d3.com',
      ip: '203.0.113.7',
      adapterSet: FORWARDS_ALL_SINCE,
    });
  });

  it('forwards every header and cookie but what the config keeps back, and echoes it', async () => {
    const h = harness({ action: 'pass' });
    await createD3Middleware(
      { ...BASE_CONFIG, excludeHeaders: ['X-Api-Key'], excludeCookies: 'sid' },
      h.deps
    )(
      new Request('https://ai.d3.com/page', {
        headers: {
          'user-agent': 'GPTBot/1.0',
          'x-api-key': 'k',
          'x-partner': 'acme',
          cookie: 'sid=s; plan=pro',
        },
      })
    );
    const body = h.policyCalls[0].body as {
      headers: Record<string, string>;
      cookies: unknown;
      excluded: unknown;
    };
    expect(body.headers['x-partner']).toBe('acme');
    expect(body.headers['x-api-key']).toBeUndefined();
    expect(body.cookies).toEqual({ plan: 'pro' });
    expect(body.excluded).toEqual({ headers: ['x-api-key'], cookies: ['sid'] });
  });

  it('forwards every header but the credentials as debugHeaders only when configured', async () => {
    const request = () =>
      new Request('https://ai.d3.com/page', {
        headers: { 'user-agent': 'GPTBot/1.0', 'x-custom': 'v', cookie: 'session=secret' },
      });
    const off = harness({ action: 'pass' });
    await createD3Middleware(BASE_CONFIG, off.deps)(request());
    expect((off.policyCalls[0].body as { debugHeaders?: unknown }).debugHeaders).toBeUndefined();

    const on = harness({ action: 'pass' });
    await createD3Middleware({ ...BASE_CONFIG, debugLogRawPayload: true }, on.deps)(request());
    expect((on.policyCalls[0].body as { debugHeaders: unknown }).debugHeaders).toEqual({
      'user-agent': 'GPTBot/1.0',
      'x-custom': 'v',
    });
  });

  it('returns a machine-readable 403 on block, without calling next()', async () => {
    const h = harness({
      action: 'block',
      policyAction: 'block',
      ruleId: 'block:gptbot',
      verdict: { verified: false, tier: 'derived', reason: 'no-signature', identity: 'gptbot' },
    });
    const res = await createD3Middleware(BASE_CONFIG, h.deps)(siteRequest());

    expect(res.status).toBe(403);
    expect(res.headers.get('x-d3-edge')).toBe('block');
    expect(await res.json()).toEqual({
      blocked: true,
      ruleId: 'block:gptbot',
      tier: 'derived',
      identity: 'gptbot',
    });
    expect(h.nextCalls).toHaveLength(0);
  });

  it('fails open (passes) when the policy call errors', async () => {
    const h = harness('throw');
    const res = await createD3Middleware(BASE_CONFIG, h.deps)(siteRequest());
    expect(res.status).toBe(200);
    expect(res.headers.get('x-d3-edge')).toBe('fail-open');
    expect(h.nextCalls).toHaveLength(1);
  });

  it('still keeps our credentials off the upstream when it fails open', async () => {
    const h = harness('throw');
    // No pay cookie: a paying request never falls open, it answers 502.
    await createD3Middleware(
      BASE_CONFIG,
      h.deps
    )(
      new Request('https://ai.d3.com/page', {
        headers: { 'user-agent': 'GPTBot/1.0', cookie: `theme=dark; __Host-d3person=${'p'.repeat(43)}` },
      })
    );

    const upstream = h.nextCalls[0]?.request?.headers;
    expect(upstream?.get('cookie')).toBe('theme=dark');
    expect(upstream?.get('d3pay-person')).toBeNull();
  });

  it('fails open on a non-2xx policy response', async () => {
    const h = harness({ status: 500 });
    const res = await createD3Middleware(BASE_CONFIG, h.deps)(siteRequest());
    expect(res.headers.get('x-d3-edge')).toBe('fail-open');
  });

  it('fails closed (403) when the site opts in', async () => {
    const h = harness('throw');
    const res = await createD3Middleware({ ...BASE_CONFIG, failMode: 'closed' }, h.deps)(siteRequest());
    expect(res.status).toBe(403);
    expect(res.headers.get('x-d3-edge')).toBe('fail-closed');
    expect(h.nextCalls).toHaveLength(0);
  });

  it('is a passthrough when no policy worker is configured', async () => {
    const h = harness({ action: 'pass' });
    const res = await createD3Middleware({}, h.deps)(siteRequest());
    expect(res.headers.get('x-d3-edge')).toBe('disabled');
    expect(h.policyCalls).toHaveLength(0);
    expect(h.nextCalls).toHaveLength(1);
  });

  it('calls the default endpoint with the key when the API key is all that is configured', async () => {
    const h = harness({ action: 'pass' });
    const res = await createD3Middleware({ apiKey: KEY }, h.deps)(siteRequest());
    expect(res.headers.get('x-d3-edge')).toBe('pass');
    expect(h.policyCalls).toHaveLength(1);
    expect(h.policyCalls[0].headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it('is a passthrough when switched off with enabled: false', async () => {
    const h = harness({ action: 'pass' });
    const res = await createD3Middleware({ apiKey: KEY, enabled: false }, h.deps)(siteRequest());
    expect(res.headers.get('x-d3-edge')).toBe('disabled');
    expect(h.policyCalls).toHaveLength(0);
  });

  describe('outcome reports', () => {
    it('reports a pass via waitUntil with no status (origin response is unobservable)', async () => {
      const h = harness({ action: 'pass', policyAction: 'log-only' });
      await createD3Middleware(BASE_CONFIG, h.deps)(siteRequest());
      await h.flushReports();

      expect(h.reportCalls).toHaveLength(1);
      const { headers, report } = h.reportCalls[0];
      expect(headers.authorization).toBe(`Bearer ${KEY}`);
      expect(report).toMatchObject({
        requestId: (h.policyCalls[0].body as { requestId: string }).requestId,
        host: 'ai.d3.com',
        path: '/page',
        method: 'GET',
        mode: 'pass',
      });
      expect(report.status).toBeUndefined();
      expect(report.originLatencyMs).toBeUndefined();
    });

    it('reports a block with the 403 it built', async () => {
      const h = harness({ action: 'block', policyAction: 'block' });
      await createD3Middleware(BASE_CONFIG, h.deps)(siteRequest());
      await h.flushReports();

      expect(h.reportCalls[0].report).toMatchObject({ mode: 'block', status: 403 });
    });

    it('tags a 200 payment instruction as a stub, not as the money gate failing closed', async () => {
      const h = harness({ action: 'pass', payment: { status: 200, headers: {}, body: '{"how":"x"}' } });
      const res = await createD3Middleware(BASE_CONFIG, h.deps)(siteRequest());
      await h.flushReports();
      expect(res.status).toBe(200);
      expect(res.headers.get('x-d3-edge')).toBe('payment-stub');
      expect(h.reportCalls[0].report).toMatchObject({ mode: 'payment-stub', status: 200 });
    });

    it('carries the answer it built, whole, and nothing for a pass it cannot see', async () => {
      const block = harness({ action: 'block', policyAction: 'block', ruleId: 'block:gptbot' });
      await createD3Middleware(BASE_CONFIG, block.deps)(siteRequest());
      await block.flushReports();
      expect(block.reportCalls[0].report.answer).toEqual({
        headers: { 'content-type': 'application/json; charset=utf-8', 'x-d3-edge': 'block' },
        body: JSON.stringify({ blocked: true, ruleId: 'block:gptbot', tier: undefined, identity: undefined }),
      });

      const challenge = harness({
        action: 'pass',
        payment: {
          status: 402,
          headers: { 'www-authenticate': 'Payment realm="ai.d3.com"' },
          body: '{"error":"payment_required"}',
        },
      });
      await createD3Middleware(BASE_CONFIG, challenge.deps)(siteRequest());
      await challenge.flushReports();
      expect(challenge.reportCalls[0].report).toMatchObject({
        mode: 'payment-required',
        status: 402,
        answer: {
          headers: { 'www-authenticate': 'Payment realm="ai.d3.com"' },
          body: '{"error":"payment_required"}',
        },
      });

      const passed = harness({ action: 'pass' });
      await createD3Middleware(BASE_CONFIG, passed.deps)(siteRequest());
      await passed.flushReports();
      expect(passed.reportCalls[0].report.answer).toBeUndefined();
    });

    it('reports fail-open and fail-closed outcomes', async () => {
      let h = harness('throw');
      await createD3Middleware(BASE_CONFIG, h.deps)(siteRequest());
      await h.flushReports();
      expect(h.reportCalls[0].report.mode).toBe('fail-open');
      expect(h.reportCalls[0].report.status).toBeUndefined();

      h = harness('throw');
      await createD3Middleware({ ...BASE_CONFIG, failMode: 'closed' }, h.deps)(siteRequest());
      await h.flushReports();
      expect(h.reportCalls[0].report).toMatchObject({ mode: 'fail-closed', status: 403 });
    });

    it('never changes the returned response when the report fetch fails', async () => {
      const h = harness({ action: 'pass' });
      h.deps.fetchImpl = (async (url: RequestInfo | URL) => {
        if (String(url) === REPORT_URL) throw new Error('report endpoint down');
        return Response.json({ action: 'pass' });
      }) as typeof fetch;

      const res = await createD3Middleware(BASE_CONFIG, h.deps)(siteRequest());
      await expect(h.flushReports()).resolves.toBeUndefined();
      expect(res.status).toBe(200);
      expect(res.headers.get('x-d3-edge')).toBe('pass');
    });

    it('sends no report in disabled mode', async () => {
      const h = harness({ action: 'pass' });
      await createD3Middleware({}, h.deps)(siteRequest());
      await h.flushReports();
      expect(h.reportCalls).toHaveLength(0);
    });
  });
});

describe('paid routes', () => {
  const paying = () =>
    new Request('https://ai.d3.com/premium', {
      headers: { 'user-agent': 'GPTBot/1.0', 'payment-signature': 'eyJ4NDAyVmVyc2lvbiI6Mn0=' },
    });

  it('never continues to the site for a status it was handed', async () => {
    const h = harness({
      action: 'pass',
      payment: { status: 402, headers: { 'payment-required': 'eyJ4IjoxfQ==' } },
    });
    const res = await createD3Middleware(BASE_CONFIG, h.deps)(siteRequest());

    expect(res.status).toBe(402);
    expect(res.headers.get('payment-required')).toBe('eyJ4IjoxfQ==');
    expect(res.headers.get('x-d3-edge')).toBe('payment-required');
    // `next()` is the routing continuation, so not calling it is not reaching
    // the site.
    expect(h.nextCalls).toHaveLength(0);
  });

  it('tags a fail-closed money answer apart from an unpaid one', async () => {
    const h = harness({ action: 'pass', payment: { status: 502, body: '{"error":"x"}' } });
    const res = await createD3Middleware(BASE_CONFIG, h.deps)(siteRequest());

    expect(res.status).toBe(502);
    expect(res.headers.get('x-d3-edge')).toBe('fail-closed');
    expect(h.nextCalls).toHaveLength(0);
  });

  it('carries a receipt onto the continuation when nothing terminates', async () => {
    const h = harness({ action: 'pass', payment: { headers: { 'payment-response': 'abc' } } });
    const res = await createD3Middleware(BASE_CONFIG, h.deps)(siteRequest());

    expect(res.status).toBe(200);
    expect(res.headers.get('payment-response')).toBe('abc');
    expect(h.nextCalls).toHaveLength(1);
  });

  it('picks the payment budget per request from one resolved config', async () => {
    // resolveConfig runs ONCE at construction here, unlike the Cloudflare
    // adapter. The budget still has to vary per request.
    const h = harness('hang');
    const mw = createD3Middleware({ ...BASE_CONFIG, timeoutMs: 30, paymentTimeoutMs: 250 }, h.deps);

    const freeStart = Date.now();
    await mw(siteRequest());
    const free = Date.now() - freeStart;

    const paidStart = Date.now();
    await mw(paying());
    const paid = Date.now() - paidStart;

    expect(h.policyCalls).toHaveLength(2);
    // Both fail open once aborted; only the wait before that differs.
    expect(paid).toBeGreaterThan(free);
  });

  it('forwards the payment header to the worker', async () => {
    const h = harness({ action: 'pass', policyAction: 'log-only' });
    await createD3Middleware(BASE_CONFIG, h.deps)(paying());

    const body = h.policyCalls[0].body as { headers: Record<string, string> };
    expect(body.headers['payment-signature']).toBe('eyJ4NDAyVmVyc2lvbiI6Mn0=');
  });
});

describe('DNA at the middleware', () => {
  const PAY_HEADERS = { 'payment-authorization': 'Payment ' + 'a'.repeat(43) };
  const SESSION = 'b'.repeat(43);
  const request = (headers: Record<string, string> = {}) =>
    new Request('https://ai.d3.com/premium', { headers: { 'user-agent': 'agent', ...headers } });

  it('classifies a 3xx payment instruction as payment-redirect with no JSON type', async () => {
    const h = harness({
      action: 'pass',
      payment: { status: 302, headers: { location: 'https://pay.example/?back=x' } },
    });
    const response = await createD3Middleware(BASE_CONFIG, h.deps)(request({ accept: 'text/html' }));
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://pay.example/?back=x');
    expect(response.headers.get('content-type')).toBeNull();
    expect(response.headers.get('x-d3-edge')).toBe('payment-redirect');
    expect(h.nextCalls).toHaveLength(0);
    await h.flushReports();
    expect(h.reportCalls[0]?.report.mode).toBe('payment-redirect');
  });

  it('rewrites the upstream request without the payment headers on a paying pass', async () => {
    const h = harness({ action: 'pass', payment: { headers: { 'payment-receipt': 'abc' } } });
    const response = await createD3Middleware(
      BASE_CONFIG,
      h.deps
    )(request({ ...PAY_HEADERS, 'payment-signature': 'sig' }));
    expect(response.headers.get('payment-receipt')).toBe('abc');
    const upstream = h.nextCalls[0]?.request?.headers;
    expect(upstream?.get('payment-authorization')).toBeNull();
    expect(upstream?.get('payment-signature')).toBeNull();
    expect(upstream?.get('user-agent')).toBe('agent');
  });

  it('forwards only our cookie, strips it from the upstream request, and sets the cookie a redemption returns', async () => {
    const h = harness({
      action: 'pass',
      payment: { headers: { 'set-cookie': '__Host-d3pay=new; Path=/; Secure; HttpOnly' } },
    });
    const response = await createD3Middleware(
      BASE_CONFIG,
      h.deps
    )(request({ cookie: `theme=dark; __Host-d3pay=${SESSION}` }));
    expect(response.headers.getSetCookie()).toContain('__Host-d3pay=new; Path=/; Secure; HttpOnly');
    const upstream = h.nextCalls[0]?.request?.headers;
    expect(upstream?.get('cookie')).toBe('theme=dark');
    const body = h.policyCalls[0].body as { headers: Record<string, string> };
    expect(body.headers['d3pay-session']).toBe(SESSION);
    expect(body.headers.cookie).toBeUndefined();
  });

  it('fails closed with 502 payment_unavailable when the decision call throws and a payment header is present', async () => {
    const h = harness('throw');
    const response = await createD3Middleware(
      { ...BASE_CONFIG, failMode: 'open' },
      h.deps
    )(request(PAY_HEADERS));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'payment_unavailable' });
    expect(response.headers.get('x-d3-edge')).toBe('fail-closed');
    expect(h.nextCalls).toHaveLength(0);
  });

  it('treats a handoff on the URL as paying: 502 rather than a fail-open pass', async () => {
    const handoff = `${'a'.repeat(22)}.${'b'.repeat(43)}`;
    const h = harness('throw');
    const response = await createD3Middleware(
      { ...BASE_CONFIG, failMode: 'open' },
      h.deps
    )(
      new Request(`https://ai.d3.com/premium?d3pay_handoff=${handoff}`, {
        headers: { 'user-agent': 'agent' },
      })
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'payment_unavailable' });
    expect(h.nextCalls).toHaveLength(0);
  });

  it('still fails open without a payment header', async () => {
    const h = harness('throw');
    const response = await createD3Middleware({ ...BASE_CONFIG, failMode: 'open' }, h.deps)(request());
    expect(response.headers.get('x-d3-edge')).toBe('fail-open');
    expect(h.nextCalls).toHaveLength(1);
  });
});

describe('payment headers never reach the origin', () => {
  it('strips an oversized credential, which does not qualify for the paying path', async () => {
    const h = harness({ action: 'pass' });
    const request = new Request('https://ai.d3.com/premium', {
      headers: {
        'payment-authorization': 'Payment ' + 'a'.repeat(4096),
        'x-payment': 'b'.repeat(8192),
        'user-agent': 'agent',
      },
    });

    await createD3Middleware(BASE_CONFIG, h.deps)(request);

    const upstream = h.nextCalls[0]?.request?.headers;
    expect(upstream?.get('payment-authorization')).toBeNull();
    expect(upstream?.get('x-payment')).toBeNull();
    expect(upstream?.get('user-agent')).toBe('agent');
  });
});
