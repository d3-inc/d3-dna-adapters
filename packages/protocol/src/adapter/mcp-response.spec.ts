import { describe, expect, it } from 'vitest';
import { MCP_KEY_ARGUMENT } from './mcp';
import {
  MCP_KEY_ARGUMENT_MEMORY_MS,
  MCP_KEY_ARGUMENT_SCHEMA,
  MCP_RESULT_MAX_BYTES,
  McpKeyArgumentMemory,
  withMcpResult,
} from './mcp-response';
import { buildPaymentResponse } from './payment-response';

const jsonRpc = (result: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify({ jsonrpc: '2.0', id: 7, result }), {
    headers: { 'content-type': 'application/json', 'content-length': '999' },
    ...init,
  });

const RECEIPT = { 'dna.d3.com/receipt': { status: 'success', charged: 1000 } };

describe('withMcpResult', () => {
  it("adds the receipt to a JSON result's _meta, keeping the origin's own entries", async () => {
    const out = await withMcpResult(jsonRpc({ content: [], _meta: { trace: 't' } }), {
      method: 'tools/call',
      meta: RECEIPT,
      keyArgument: false,
    });
    expect(out.headers.has('content-length')).toBe(false);
    expect((await out.json()).result._meta).toEqual({ trace: 't', ...RECEIPT });
  });

  it("drops the origin's digests and validator on a rewritten result, which no longer match", async () => {
    const out = await withMcpResult(
      jsonRpc(
        { content: [] },
        {
          headers: {
            'content-type': 'application/json',
            etag: '"abc"',
            'content-digest': 'sha-256=:x:',
            'repr-digest': 'sha-256=:x:',
            'content-md5': 'x',
            'cache-control': 'private',
          },
        }
      ),
      { method: 'tools/call', meta: RECEIPT, keyArgument: false }
    );
    for (const name of ['etag', 'content-digest', 'repr-digest', 'content-md5']) {
      expect(out.headers.has(name)).toBe(false);
    }

    expect(out.headers.get('cache-control')).toBe('private');
  });

  it('leaves an event stream, an error and a non-JSON-RPC body alone', async () => {
    const stream = new Response('data: {}\n\n', { headers: { 'content-type': 'text/event-stream' } });
    expect(await withMcpResult(stream, { method: 'tools/call', meta: RECEIPT, keyArgument: false })).toBe(
      stream
    );

    const error = new Response(JSON.stringify({ jsonrpc: '2.0', id: 7, error: { code: -1 } }), {
      headers: { 'content-type': 'application/json' },
    });
    const kept = await withMcpResult(error, { method: 'tools/call', meta: RECEIPT, keyArgument: false });
    expect(await kept.json()).toEqual({ jsonrpc: '2.0', id: 7, error: { code: -1 } });

    const plain = new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } });
    expect(await (await withMcpResult(plain, { meta: RECEIPT, keyArgument: false })).text()).toBe(
      '{"ok":true}'
    );
  });

  it('passes a result it does not rewrite through byte for byte, its length intact', async () => {
    const body = new Uint8Array([
      0xef,
      0xbb,
      0xbf,
      ...new TextEncoder().encode('{"jsonrpc":"2.0","id":7,"error":{}}'),
    ]);
    const response = new Response(body, {
      headers: { 'content-type': 'application/json', 'content-length': String(body.byteLength) },
    });
    const out = await withMcpResult(response, { method: 'tools/call', meta: RECEIPT, keyArgument: false });
    expect(out.headers.get('content-length')).toBe(String(body.byteLength));
    expect(new Uint8Array(await out.arrayBuffer())).toEqual(body);
  });

  it('passes one chunk far past the cap through as it came', async () => {
    const huge = new Uint8Array(MCP_RESULT_MAX_BYTES * 3).fill(0x20);
    const oneChunk = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(huge);
        controller.close();
      },
    });
    const out = await withMcpResult(
      new Response(oneChunk, { headers: { 'content-type': 'application/json' } }),
      {
        method: 'tools/call',
        meta: RECEIPT,
        keyArgument: false,
      }
    );
    expect((await out.arrayBuffer()).byteLength).toBe(huge.byteLength);
  });

  it('streams a result past the cap on whole, without holding it', async () => {
    const big = new Uint8Array(MCP_RESULT_MAX_BYTES + 10).fill(0x20);
    const out = await withMcpResult(new Response(big, { headers: { 'content-type': 'application/json' } }), {
      method: 'tools/call',
      meta: RECEIPT,
      keyArgument: false,
    });
    expect((await out.arrayBuffer()).byteLength).toBe(big.byteLength);
  });

  it('returns the response itself when there is nothing to add', async () => {
    const response = jsonRpc({ tools: [] });
    expect(await withMcpResult(response, { method: 'tools/list', keyArgument: false })).toBe(response);
  });

  it('adds the key argument to every tool of a tools/list result, only when asked', async () => {
    const tools = [
      { name: 'a', inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } },
      { name: 'b' },
    ];
    const out = await withMcpResult(jsonRpc({ tools }), { method: 'tools/list', keyArgument: true });
    const listed = (await out.json()).result.tools;
    expect(listed[0].inputSchema).toEqual({
      type: 'object',
      properties: { q: { type: 'string' }, [MCP_KEY_ARGUMENT]: MCP_KEY_ARGUMENT_SCHEMA },
      required: ['q'],
    });
    expect(listed[1].inputSchema.properties).toEqual({ [MCP_KEY_ARGUMENT]: MCP_KEY_ARGUMENT_SCHEMA });

    const call = await withMcpResult(jsonRpc({ tools }), { method: 'tools/call', keyArgument: true });
    expect((await call.json()).result.tools[1]).toEqual({ name: 'b' });
  });
});

describe('McpKeyArgumentMemory', () => {
  it('holds per host for five minutes, and an off decision clears it', () => {
    const memory = new McpKeyArgumentMemory();
    memory.remember('a.com', true, 0);
    expect(memory.isOn('a.com', MCP_KEY_ARGUMENT_MEMORY_MS - 1)).toBe(true);
    expect(memory.isOn('a.com', MCP_KEY_ARGUMENT_MEMORY_MS)).toBe(false);
    expect(memory.isOn('b.com', 0)).toBe(false);

    memory.remember('a.com', true, 0);
    memory.remember('a.com', false, 1);
    expect(memory.isOn('a.com', 2)).toBe(false);
  });
});

describe('buildPaymentResponse, json-rpc', () => {
  it("answers 200 with the call's id and the result, and the binding's headers beside it", async () => {
    const result = { isError: true, structuredContent: { x402Version: 2 } };
    const res = buildPaymentResponse(
      {
        status: 402,
        bodyKind: 'json-rpc',
        body: JSON.stringify(result),
        headers: { 'payment-required': 'e30=' },
      },
      'payment-required',
      'call-1'
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('payment-required')).toBe('e30=');
    expect(res.headers.get('x-d3-edge')).toBe('payment-required');
    expect(await res.json()).toEqual({ jsonrpc: '2.0', id: 'call-1', result });
  });

  it('gives the plain answer when the adapter read no call to reply to', async () => {
    const res = buildPaymentResponse(
      { status: 402, bodyKind: 'json-rpc', body: '{"x":1}' },
      'payment-required'
    );
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ x: 1 });
  });

  it('fails closed on a result that is not JSON', () => {
    const res = buildPaymentResponse({ status: 402, bodyKind: 'json-rpc', body: '{' }, 'payment-required', 1);
    expect(res.status).toBe(502);
    expect(res.headers.get('x-d3-edge')).toBe('fail-closed');
  });
});
