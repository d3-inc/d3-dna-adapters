import { describe, expect, it } from 'vitest';
import { MCP_DNA_KEY_HEADER } from './forwarding.constants';
import {
  liftMcpPayment,
  MCP_BODY_MAX_BYTES,
  mcpCarriageOf,
  mcpOriginRequest,
  oversizedCallNamesCredential,
  readJsonRpcRequest,
  recordedMcpCall,
} from './mcp';

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).buffer as ArrayBuffer;

describe('oversizedCallNamesCredential', () => {
  const call = (meta: Record<string, unknown>, padding = MCP_BODY_MAX_BYTES) =>
    encode({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { pad: 'x'.repeat(padding), _meta: meta },
    });

  it('flags a call too large to read that names any credential key', () => {
    for (const meta of [{ 'dna.d3.com/key': 'k' }, { 'x402/payment': {} }]) {
      expect(oversizedCallNamesCredential('POST', 'application/json', call(meta))).toBe(true);
    }

    const argument = encode({
      params: { arguments: { dna_account_key: 'k' }, pad: 'x'.repeat(MCP_BODY_MAX_BYTES) },
    });
    expect(oversizedCallNamesCredential('POST', 'application/json', argument)).toBe(true);
  });

  it('leaves alone a large body that names none, one small enough to read, and a non-JSON POST', () => {
    expect(oversizedCallNamesCredential('POST', 'application/json', call({ trace: 't' }))).toBe(false);
    expect(
      oversizedCallNamesCredential('POST', 'application/json', call({ 'dna.d3.com/key': 'k' }, 10))
    ).toBe(false);
    expect(oversizedCallNamesCredential('POST', 'text/plain', call({ 'dna.d3.com/key': 'k' }))).toBe(false);
  });
});
const JSON_TYPE = 'application/json';

const call = (params: Record<string, unknown>, method = 'tools/call') => ({
  jsonrpc: '2.0',
  id: 7,
  method,
  params,
});

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://mcp.a.com/mcp', {
    method: 'POST',
    headers: { 'content-type': JSON_TYPE, ...headers },
    body: JSON.stringify(body),
  });
}

describe('readJsonRpcRequest', () => {
  it('reads one JSON-RPC request in a JSON POST', () => {
    expect(
      readJsonRpcRequest('POST', 'application/json; charset=utf-8', encode(call({ name: 'x' })))
    ).toEqual({
      id: 7,
      method: 'tools/call',
      params: { name: 'x' },
    });
  });

  it('reads nothing from a batch, a response, a GET, another type, or an oversized body', () => {
    expect(readJsonRpcRequest('POST', JSON_TYPE, encode([call({})]))).toBeNull();
    expect(readJsonRpcRequest('POST', JSON_TYPE, encode({ jsonrpc: '2.0', id: 1, result: {} }))).toBeNull();
    expect(readJsonRpcRequest('GET', JSON_TYPE, encode(call({})))).toBeNull();
    expect(readJsonRpcRequest('POST', 'text/plain', encode(call({})))).toBeNull();
    expect(readJsonRpcRequest('POST', JSON_TYPE, new ArrayBuffer(MCP_BODY_MAX_BYTES + 1))).toBeNull();
    expect(
      readJsonRpcRequest('POST', JSON_TYPE, new TextEncoder().encode('{nope').buffer as ArrayBuffer)
    ).toBeNull();
  });
});

describe('mcpCarriageOf', () => {
  it('takes the method and tool from the body, over headers that disagree, and says so', async () => {
    const request = post(call({ name: 'get_report' }), { 'mcp-method': 'tools/list', 'mcp-name': 'other' });
    const carriage = mcpCarriageOf(request, await request.clone().arrayBuffer());
    expect(carriage.facts).toEqual({ method: 'tools/call', tool: 'get_report', source: 'body' });
  });

  it("labels the headers as the client's claim when the body is not one call, never mixing the two", async () => {
    const request = post([call({ name: 'paid' })], { 'mcp-method': 'tools/list', 'mcp-name': 'free' });
    const carriage = mcpCarriageOf(request, await request.clone().arrayBuffer());
    expect(carriage.rpc).toBeNull();
    expect(carriage.facts).toEqual({ method: 'tools/list', tool: 'free', source: 'headers' });
    expect(carriage.lifted).toEqual({});

    const listed = post(call({}, 'tools/list'), { 'mcp-name': 'claimed' });
    expect(mcpCarriageOf(listed, await listed.clone().arrayBuffer()).facts).toEqual({
      method: 'tools/list',
      source: 'body',
    });
  });

  it('names the resource without its query or credentials, and the prompt', async () => {
    const read = post(call({ uri: 'postgres://user:pass@db.example/r?api_key=s#x' }, 'resources/read'));
    expect(mcpCarriageOf(read, await read.clone().arrayBuffer()).facts?.tool).toBe('postgres://db.example/r');
    const prompt = post(call({ name: 'summarize' }, 'prompts/get'));
    expect(mcpCarriageOf(prompt, await prompt.clone().arrayBuffer()).facts?.tool).toBe('summarize');
  });

  it('lifts the mirrored key header, whatever the site switch says', async () => {
    const request = post(call({ name: 'a' }), { [MCP_DNA_KEY_HEADER]: 'dna_k_1' });
    expect(mcpCarriageOf(request, await request.clone().arrayBuffer()).lifted).toEqual({
      'payment-authorization': 'Payment dna_k_1',
    });
  });

  it('reads no facts from a request that names no call', async () => {
    const request = new Request('https://a.com/page');
    expect(mcpCarriageOf(request, new ArrayBuffer(0)).facts).toBeNull();
  });
});

describe('liftMcpPayment', () => {
  it('lifts an x402 payment into payment-signature and leaves the rest of _meta', () => {
    const payment = { x402Version: 2, payload: { signature: '0xabc' } };
    const { lifted, originBody } = liftMcpPayment({
      id: 1,
      method: 'tools/call',
      params: { name: 'a', _meta: { 'x402/payment': payment, trace: 't' } },
    });
    expect(JSON.parse(atob(lifted['payment-signature']))).toEqual(payment);
    expect(JSON.parse(originBody!)).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'a', _meta: { trace: 't' } },
    });
  });

  it('lifts the DNA key from _meta, and drops an emptied _meta', () => {
    const { lifted, originBody } = liftMcpPayment({
      id: 'x',
      method: 'tools/call',
      params: { name: 'a', _meta: { 'dna.d3.com/key': 'dna_k_1' } },
    });
    expect(lifted).toEqual({ 'payment-authorization': 'Payment dna_k_1' });
    expect(JSON.parse(originBody!).params).toEqual({ name: 'a' });
  });

  it('always lifts the dna_account_key argument, so a cold isolate never hands it to the origin', () => {
    const rpc = {
      id: 1,
      method: 'tools/call',
      params: { name: 'a', arguments: { q: 'x', dna_account_key: 'k' } },
    };
    const lifted = liftMcpPayment(rpc);
    expect(lifted.lifted).toEqual({ 'payment-authorization': 'Payment k' });
    expect(JSON.parse(lifted.originBody!).params.arguments).toEqual({ q: 'x' });
  });

  it('strips a payment it cannot lift, so the origin still never sees it', () => {
    const { lifted, originBody } = liftMcpPayment({
      id: 1,
      method: 'tools/call',
      params: { _meta: { 'x402/payment': 'not-an-object' } },
    });
    expect(lifted).toEqual({});
    expect(JSON.parse(originBody!).params).toEqual({});
  });

  it('changes nothing on a call that carries no payment', () => {
    expect(liftMcpPayment({ id: 1, method: 'tools/call', params: { name: 'a' } })).toEqual({
      lifted: {},
      originBody: null,
    });
  });
});

describe('mcpOriginRequest', () => {
  it('hands the origin the stripped body, without a stale length or digest, keeping the signal', async () => {
    const controller = new AbortController();
    const request = new Request('https://mcp.a.com/mcp', {
      method: 'POST',
      headers: { 'content-type': JSON_TYPE, 'content-length': '999', 'content-digest': 'sha-256=:x:' },
      body: JSON.stringify(call({ name: 'a', _meta: { 'dna.d3.com/key': 'k' } })),
      signal: controller.signal,
    });
    const carriage = mcpCarriageOf(request, await request.clone().arrayBuffer());
    const origin = mcpOriginRequest(request, carriage);
    expect(origin.headers.has('content-length')).toBe(false);
    expect(origin.headers.has('content-digest')).toBe(false);
    controller.abort();
    expect(origin.signal.aborted).toBe(true);
    expect(await origin.json()).toEqual({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'a' },
    });
  });

  it("keeps the request's own class, so a framework's request type reaches its handler", async () => {
    class FrameworkRequest extends Request {}
    const request = new FrameworkRequest('https://mcp.a.com/mcp', {
      method: 'POST',
      headers: { 'content-type': JSON_TYPE },
      body: JSON.stringify(call({ _meta: { 'dna.d3.com/key': 'k' } })),
    });
    const carriage = mcpCarriageOf(request, await request.clone().arrayBuffer());
    expect(mcpOriginRequest(request, carriage)).toBeInstanceOf(FrameworkRequest);
  });

  it('returns the request itself when nothing is to come out', () => {
    const request = new Request('https://a.com/');
    expect(mcpOriginRequest(request, null)).toBe(request);
  });
});

describe('recordableName', () => {
  it('drops the query and credentials from a URI named in a header, on every path that records it', async () => {
    const leaky = 'postgres://user:pass@db/r?token=secret';
    const listed = post([call({})], { 'mcp-method': 'resources/read', 'mcp-name': leaky });
    expect(mcpCarriageOf(listed, await listed.clone().arrayBuffer()).facts?.tool).toBe('postgres://db/r');
    expect(recordedMcpCall({ headers: { 'mcp-name': leaky } }).tool).toBe('postgres://db/r');
    expect(recordedMcpCall({ mcp: { tool: leaky, source: 'headers' }, headers: {} }).tool).toBe(
      'postgres://db/r'
    );
  });
});

describe('recordedMcpCall', () => {
  it("prefers the adapter's reading, else a revision 2 adapter's plain mirror headers", () => {
    expect(
      recordedMcpCall({ mcp: { method: 'tools/call', source: 'body' }, headers: { 'mcp-method': 'x' } })
    ).toEqual({
      method: 'tools/call',
    });
    expect(recordedMcpCall({ headers: { 'mcp-method': 'tools/call', 'mcp-name': 'a' } })).toEqual({
      method: 'tools/call',
      tool: 'a',
    });
    expect(recordedMcpCall({ headers: { 'mcp-method': 'x'.repeat(200) } })).toEqual({});
  });
});
