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

const call = (params: Record<string, unknown>) =>
  new Request('https://mcp.example/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
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

  it('runs the route untouched when DNA is off', async () => {
    const h = harness({ action: 'pass' });
    const request = call({ name: 'a' });
    await withD3Mcp(h.handler, { endpoint: '' }, h.deps)(request);
    expect(h.decisions).toHaveLength(0);
    expect(h.handled[0]).toBe(request);
  });
});
