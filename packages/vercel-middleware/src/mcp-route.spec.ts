import { ADAPTER_SET, type ClientDecision, type RequestPayload } from '@d3-inc/d3-dna-protocol';
import { describe, expect, it } from 'vitest';
import { withD3Mcp, type McpRouteDeps } from './mcp-route';

const URL = 'https://edge-api.d3.com/v1/decision';
const REPORT_URL = 'https://edge-api.d3.com/v1/report';
const CONFIG = { endpoint: URL, apiKey: 'd3_k_' + 'a'.repeat(43) + 'AAAAAA', timeoutMs: 1000 };

function harness(decision: ClientDecision | 'throw') {
  const decisions: RequestPayload[] = [];
  const names: (string | null)[] = [];
  const handled: Request[] = [];
  const deps: McpRouteDeps = {
    ipAddress: () => '203.0.113.7',
    waitUntil: () => {},
    fetchImpl: (async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url) === REPORT_URL) return new Response(null, { status: 202 });

      decisions.push(JSON.parse(init?.body as string) as RequestPayload);
      names.push(new Headers(init?.headers).get('dna-adapter'));
      if (decision === 'throw') throw new Error('boom');

      return Response.json(decision);
    }) as typeof fetch,
  };
  const handler = async (request: Request) => {
    handled.push(request);
    return Response.json({ jsonrpc: '2.0', id: 1, result: { content: [] } });
  };

  return { deps, decisions, names, handled, handler };
}

const call = (
  params: Record<string, unknown>,
  { url = 'https://mcp.example/mcp', headers = {} }: { url?: string; headers?: Record<string, string> } = {}
) =>
  new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params }),
  });

describe('withD3Mcp', () => {
  it('decides a call once, at revision 3, and hands the route the call without its payment', async () => {
    const h = harness({ action: 'pass' });
    await withD3Mcp(h.handler, CONFIG, h.deps)(call({ name: 'a', _meta: { 'dna.d3.com/key': 'dna_k_1' } }));

    expect(h.decisions).toHaveLength(1);
    expect(h.names).toEqual(['vercel-mcp:0.0.0-test']);
    expect(h.decisions[0]).toMatchObject({
      adapterSet: ADAPTER_SET,
      mcp: { method: 'tools/call', tool: 'a' },
      headers: { 'payment-authorization': 'Payment dna_k_1' },
    });
    expect(await h.handled[0].json()).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'a' },
    });
  });

  it("puts the receipt in the route's result", async () => {
    const meta = { 'x402/payment-response': { success: true } };
    const h = harness({ action: 'pass', payment: { meta } });
    const res = await withD3Mcp(h.handler, CONFIG, h.deps)(call({ name: 'a' }));
    expect((await res.json()).result._meta).toEqual(meta);
    expect(res.headers.get('x-d3-edge')).toBe('pass');
  });

  it('answers an unpaid call itself and never runs the route', async () => {
    const h = harness({
      action: 'pass',
      payment: { status: 402, bodyKind: 'json-rpc', body: '{"isError":true}' },
    });
    const res = await withD3Mcp(h.handler, CONFIG, h.deps)(call({ name: 'a' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jsonrpc: '2.0', id: 1, result: { isError: true } });
    expect(h.handled).toHaveLength(0);
  });

  it('fails open to the route without the credential, and closed when the call carried a payment', async () => {
    const open = harness('throw');
    const passed = await withD3Mcp(open.handler, CONFIG, open.deps)(call({ name: 'a' }));
    expect(passed.headers.get('x-d3-edge')).toBe('fail-open');
    expect(open.handled).toHaveLength(1);

    const paying = harness('throw');
    const refused = await withD3Mcp(
      paying.handler,
      CONFIG,
      paying.deps
    )(call({ name: 'a', _meta: { 'dna.d3.com/key': 'k' } }));
    expect(refused.status).toBe(502);
    expect(paying.handled).toHaveLength(0);
  });

  it('refuses a call too large to read that names a credential, without deciding or running the route', async () => {
    const h = harness({ action: 'pass' });
    const res = await withD3Mcp(
      h.handler,
      CONFIG,
      h.deps
    )(call({ name: 'a', pad: 'x'.repeat(1_048_576), _meta: { 'dna.d3.com/key': 'dna_k_1' } }));

    expect(res.status).toBe(413);
    expect(h.decisions).toHaveLength(0);
    expect(h.handled).toHaveLength(0);
  });

  it('refuses a call sent as another content type that names a credential, without running the route', async () => {
    const h = harness({ action: 'pass' });
    const plain = new Request('https://mcp.example/mcp', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { arguments: { dna_account_key: 'k' } },
      }),
    });
    const res = await withD3Mcp(h.handler, CONFIG, h.deps)(plain);

    expect(res.status).toBe(400);
    expect(h.decisions).toHaveLength(0);
    expect(h.handled).toHaveLength(0);
  });

  it('falls open when the only credential was a lifted key past its cap', async () => {
    const h = harness('throw');
    const res = await withD3Mcp(
      h.handler,
      CONFIG,
      h.deps
    )(call({ name: 'a', _meta: { 'dna.d3.com/key': 'k'.repeat(5000) } }));

    expect(res.headers.get('x-d3-edge')).toBe('fail-open');
    expect(((await h.handled[0].json()) as { params: unknown }).params).toEqual({ name: 'a' });
  });

  it("hands the route its own request type and Next's second argument, even after a strip", async () => {
    class NextLikeRequest extends Request {}
    const seen: { request: Request; context: unknown }[] = [];
    const h = harness({ action: 'pass' });
    const route = withD3Mcp(
      async (request: NextLikeRequest, context: { params: Promise<{ transport: string }> }) => {
        seen.push({ request, context });
        return Response.json({ jsonrpc: '2.0', id: 1, result: {} });
      },
      CONFIG,
      h.deps
    );
    const paid = new NextLikeRequest('https://mcp.example/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { _meta: { 'dna.d3.com/key': 'k' } },
      }),
    });
    const context = { params: Promise.resolve({ transport: 'mcp' }) };
    await route(paid, context);
    expect(seen[0].request).toBeInstanceOf(NextLikeRequest);
    expect(seen[0].context).toBe(context);
  });

  it("keeps every credential and name of ours from the route, and the site's own on it, on a pass and when it fails open", async () => {
    // A paying call never falls open, so the fail-open call's credentials are each past their cap.
    for (const [mode, decision, credential] of [
      ['pass', { action: 'pass' }, 'c'.repeat(43)],
      ['fail-open', 'throw', 'c'.repeat(4097)],
    ] as const) {
      const h = harness(decision);
      const res = await withD3Mcp(
        h.handler,
        CONFIG,
        h.deps
      )(
        call(
          { name: 'a' },
          {
            url: 'https://mcp.example/mcp?x=1&d3pay_browser=e30&d3pay_later=1',
            headers: {
              cookie: `theme=dark; __Host-d3pay=${credential}; __Host-d3person=${credential}; __Host-d3visitor=V1`,
              'd3pay-session': credential,
              'payment-signature': credential,
            },
          }
        )
      );

      expect(res.headers.get('x-d3-edge')).toBe(mode);
      const route = h.handled[0];
      expect(route.url).toBe('https://mcp.example/mcp?x=1');
      expect(route.headers.get('cookie')).toBe('theme=dark');
      expect(route.headers.get('d3pay-session')).toBeNull();
      expect(route.headers.get('payment-signature')).toBeNull();
    }
  });

  it('forwards every header and cookie but what the config keeps back, and echoes it', async () => {
    const h = harness({ action: 'pass' });
    await withD3Mcp(
      h.handler,
      { ...CONFIG, excludeHeaders: ['X-Api-Key'], excludeCookies: 'sid' },
      h.deps
    )(call({ name: 'a' }, { headers: { 'x-api-key': 'k', 'x-partner': 'acme', cookie: 'sid=s; plan=pro' } }));

    expect(h.decisions[0].headers['x-partner']).toBe('acme');
    expect(h.decisions[0].headers['x-api-key']).toBeUndefined();
    expect(h.decisions[0].cookies).toEqual({ plan: 'pro' });
    expect(h.decisions[0].excluded).toEqual({ headers: ['x-api-key'], cookies: ['sid'] });
  });

  it("puts our Set-Cookie after the route's own, and the receipt, on the route's response", async () => {
    const h = harness({
      action: 'pass',
      payment: {
        headers: { 'set-cookie': '__Host-d3pay=new; Path=/; Secure; HttpOnly', 'payment-receipt': 'abc' },
      },
    });
    const route = async () =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), {
        headers: [
          ['content-type', 'application/json'],
          ['set-cookie', 'site=1; Path=/'],
        ],
      });
    const res = await withD3Mcp(route, CONFIG, h.deps)(call({ name: 'a' }));

    expect(res.headers.getSetCookie()).toEqual([
      'site=1; Path=/',
      '__Host-d3pay=new; Path=/; Secure; HttpOnly',
    ]);
    expect(res.headers.get('payment-receipt')).toBe('abc');
  });

  it('hands the route only what the caller sent, building nothing from the verdict', async () => {
    const h = harness({
      action: 'pass',
      verdict: { verified: false, tier: 'claimed', reason: 'unknown-key', identity: 'test-bot' },
    });
    await withD3Mcp(
      h.handler,
      CONFIG,
      h.deps
    )(call({ name: 'a' }, { headers: { 'user-agent': 'TestBot/1.0', 'x-d3-tier': 'verified' } }));

    expect(Object.fromEntries(h.handled[0].headers)).toEqual({
      'content-type': 'application/json',
      'user-agent': 'TestBot/1.0',
      'x-d3-tier': 'verified',
    });
  });

  it('runs the route untouched when DNA is off', async () => {
    const h = harness({ action: 'pass' });
    const request = call({ name: 'a' });
    await withD3Mcp(h.handler, { endpoint: '' }, h.deps)(request);
    expect(h.decisions).toHaveLength(0);
    expect(h.handled[0]).toBe(request);
  });
});
