import { describe, expect, it } from 'vitest';
import { ANS_ARTIFACT_MAX_BASE64_LENGTH } from '../ans';
import { PAYMENT_AUTHORIZATION_MAX_LENGTH, VISITOR_ID_HEADER } from '../pay-session';
import { NEVER_FORWARDED_HEADERS } from './forwarding.constants';
import { X402_MAX_PAYMENT_HEADER_LENGTH } from '../x402/payment-header';
import {
  ACCEPT_MAX_LENGTH,
  extractEdgeRequest,
  extractPayload,
  FORWARDED_HEADER_SET,
  sha256ContentDigest,
} from './extract';

describe('extractPayload', () => {
  it('should forward only the allowlisted headers', async () => {
    const payload = await extractPayload(
      new Request('https://ai.d3.com/', {
        headers: {
          signature: 'sig1=:abc:',
          'signature-input': 'sig1=("@authority");keyid="k"',
          'signature-agent': '"https://agent.example.com"',
          'user-agent': 'TestBot',
          'sec-purpose': 'prefetch',
          cookie: 'session=secret',
          authorization: 'Bearer user-token',
        },
      })
    );
    expect(Object.keys(payload.headers).sort()).toEqual([
      'sec-purpose',
      'signature',
      'signature-agent',
      'signature-input',
      'user-agent',
    ]);
  });

  it('forwards every header but the credentials as debugHeaders, and only when asked', async () => {
    const request = () =>
      new Request('https://ai.d3.com/', {
        headers: {
          'user-agent': 'TestBot',
          'x-custom': 'v',
          cookie: 'session=secret',
          authorization: 'Bearer t',
        },
      });
    expect((await extractPayload(request())).debugHeaders).toBeUndefined();

    const payload = await extractPayload(request(), { debugHeaders: true });
    expect(payload.debugHeaders).toEqual({ 'user-agent': 'TestBot', 'x-custom': 'v' });
    // The verifier's input is the allowlist either way.
    expect(Object.keys(payload.headers)).toEqual(['user-agent']);
  });

  it('should forward the two ANS staple headers when present', async () => {
    const payload = await extractPayload(
      new Request('https://ai.d3.com/', {
        headers: {
          'x-scitt-receipt': 'cmVjZWlwdA==',
          'x-ans-status-token': 'dG9rZW4=',
          'user-agent': 'TestBot',
        },
      })
    );
    expect(Object.keys(payload.headers).sort()).toEqual([
      'user-agent',
      'x-ans-status-token',
      'x-scitt-receipt',
    ]);
  });

  it('should forward the DPoP proof but never the Authorization it may bind (ADR 0025)', async () => {
    const payload = await extractPayload(
      new Request('https://ai.d3.com/', {
        headers: {
          dpop: 'eyJhbGciOiJFUzI1NiJ9.e30.c2ln',
          authorization: 'DPoP access-token',
          'user-agent': 'TestBot',
        },
      })
    );
    expect(payload.headers['dpop']).toBe('eyJhbGciOiJFUzI1NiJ9.e30.c2ln');
    expect(payload.headers['authorization']).toBeUndefined();
  });

  it('should drop a DPoP header over its own 8 KiB cap, not the 1 MiB staple bound', async () => {
    const payload = await extractPayload(
      new Request('https://ai.d3.com/', { headers: { dpop: 'A'.repeat(8_193) } })
    );
    expect(payload.headers['dpop']).toBeUndefined();
  });

  it('should drop an ANS header over the base64 length cap, not forward it', async () => {
    const oversized = 'A'.repeat(ANS_ARTIFACT_MAX_BASE64_LENGTH + 4);
    const payload = await extractPayload(
      new Request('https://ai.d3.com/', {
        headers: { 'x-ans-status-token': oversized, 'x-scitt-receipt': 'ok' },
      })
    );
    expect(payload.headers['x-ans-status-token']).toBeUndefined();
    expect(payload.headers['x-scitt-receipt']).toBe('ok'); // the in-bounds one still forwards
  });

  it('should forward a payment header under its cap and drop one over it, without decoding either', async () => {
    const payload = await extractPayload(
      new Request('https://ai.d3.com/premium', {
        headers: {
          'payment-signature': 'eyJ4IjoxfQ==',
          'x-payment': 'a'.repeat(X402_MAX_PAYMENT_HEADER_LENGTH + 1),
        },
      })
    );
    expect(payload.headers['payment-signature']).toBe('eyJ4IjoxfQ==');
    expect(payload.headers['x-payment']).toBeUndefined();
  });

  it('should carry the caller-supplied client IP (platform-agnostic)', async () => {
    const payload = await extractPayload(new Request('https://ai.d3.com/'), { ip: '203.0.113.7' });
    expect(payload.ip).toBe('203.0.113.7');
    // No IP supplied → undefined (core never reads a platform header).
    const none = await extractPayload(new Request('https://ai.d3.com/'));
    expect(none.ip).toBeUndefined();
  });

  it('should compute content-digest from the actual body (tamper-evidence)', async () => {
    const body = 'hello world';
    const payload = await extractPayload(
      new Request('https://ai.d3.com/submit', {
        method: 'POST',
        body,
        // A lying digest header gets overwritten by the recomputed value.
        headers: { 'content-digest': 'sha-256=:bogus:' },
      })
    );
    expect(payload.headers['content-digest']).toBe(
      await sha256ContentDigest(await new Response(body).arrayBuffer())
    );
    // RFC 9530 test vector for "hello world".
    expect(payload.headers['content-digest']).toBe('sha-256=:uU0nuZNNPgilLlLX2n2r+sSE7+N6U4DukIj3rOLvzek=:');
  });

  it('should leave GET requests digest-free', async () => {
    const payload = await extractPayload(new Request('https://ai.d3.com/'));
    expect(payload.headers['content-digest']).toBeUndefined();
    expect(payload.method).toBe('GET');
  });

  it('should overwrite a forged content-digest on an empty body (no body-smuggling)', async () => {
    const emptyDigest = await sha256ContentDigest(new ArrayBuffer(0));
    const post = await extractPayload(
      new Request('https://ai.d3.com/submit', {
        method: 'POST',
        body: '',
        headers: { 'content-digest': 'sha-256=:bogusNonEmptyClaim:' },
      })
    );
    expect(post.headers['content-digest']).toBe(emptyDigest);

    const get = await extractPayload(
      new Request('https://ai.d3.com/', {
        headers: { 'content-digest': 'sha-256=:bogusNonEmptyClaim:' },
      })
    );
    expect(get.headers['content-digest']).toBe(emptyDigest);
  });

  it('should NOT add a digest to a body-less request that never had one', async () => {
    // Would otherwise trip the policy worker's insufficient-coverage check for
    // a legitimately body-less signed request.
    const payload = await extractPayload(
      new Request('https://ai.d3.com/submit', { method: 'POST', body: '' })
    );
    expect(payload.headers['content-digest']).toBeUndefined();
  });
});

describe('extractPayload payment credential and accept', () => {
  it('forwards payment-authorization and accept under their caps and drops either over it', async () => {
    const request = new Request('https://x.example/premium', {
      headers: {
        'payment-authorization': 'Payment d3_p_abc',
        accept: 'text/html,application/xhtml+xml',
      },
    });
    const payload = await extractPayload(request);
    expect(payload.headers['payment-authorization']).toBe('Payment d3_p_abc');
    expect(payload.headers.accept).toBe('text/html,application/xhtml+xml');

    const long = await extractPayload(
      new Request('https://x.example/premium', {
        headers: {
          'payment-authorization': 'Payment ' + 'a'.repeat(PAYMENT_AUTHORIZATION_MAX_LENGTH),
          accept: 'a'.repeat(ACCEPT_MAX_LENGTH + 1),
        },
      })
    );
    expect(long.headers['payment-authorization']).toBeUndefined();
    expect(long.headers.accept).toBeUndefined();
  });
});

describe('extractPayload navigation headers and the pay cookie', () => {
  it('forwards the navigation tells and only our cookie, under its own name', async () => {
    const token = 'a'.repeat(43);
    const payload = await extractPayload(
      new Request('https://x.example/premium', {
        headers: {
          'sec-fetch-mode': 'navigate',
          'sec-fetch-dest': 'document',
          'upgrade-insecure-requests': '1',
          cookie: `theme=dark; __Host-d3pay=${token}`,
        },
      })
    );
    expect(payload.headers['sec-fetch-mode']).toBe('navigate');
    expect(payload.headers['sec-fetch-dest']).toBe('document');
    expect(payload.headers['upgrade-insecure-requests']).toBe('1');
    expect(payload.headers['d3pay-session']).toBe(token);
    expect(payload.headers.cookie).toBeUndefined();
  });

  it('forwards the browser-check pass under its own name, and only under its cap', async () => {
    const pass = `1760000000000.${'p'.repeat(43)}`;
    const payload = await extractPayload(
      new Request('https://x.example/premium', { headers: { cookie: `__Host-d3person=${pass}; theme=dark` } })
    );
    expect(payload.headers['d3pay-person']).toBe(pass);
    expect(payload.headers['d3pay-session']).toBeUndefined();

    const long = await extractPayload(
      new Request('https://x.example/premium', { headers: { cookie: `__Host-d3person=${'a'.repeat(65)}` } })
    );
    expect(long.headers['d3pay-person']).toBeUndefined();
  });

  it('forwards the visitor id under its own name, and only under its cap', async () => {
    const id = ['v'.repeat(22), '1760000000000', 's'.repeat(43)].join('.');
    const payload = await extractPayload(
      new Request('https://x.example/premium', {
        headers: { cookie: `__Secure-d3visitor=${id}; theme=dark` },
      })
    );
    expect(payload.headers['d3-visitor']).toBe(id);
    // The site's own cookies still reach the origin; ours never do.
    expect(payload.headers.cookie).toBeUndefined();

    const long = await extractPayload(
      new Request('https://x.example/premium', {
        headers: { cookie: `__Secure-d3visitor=${'a'.repeat(97)}` },
      })
    );
    expect(long.headers['d3-visitor']).toBeUndefined();
  });

  it('drops an oversized navigation header and an oversized cookie value', async () => {
    const payload = await extractPayload(
      new Request('https://x.example/premium', {
        headers: { 'sec-fetch-mode': 'x'.repeat(33), cookie: `__Host-d3pay=${'a'.repeat(65)}` },
      })
    );
    expect(payload.headers['sec-fetch-mode']).toBeUndefined();
    expect(payload.headers['d3pay-session']).toBeUndefined();
  });
});

describe('client hints and the header-set stamp (ADR 0060)', () => {
  it('forwards the hint headers under their cap and stamps the allowlist revision', async () => {
    const payload = await extractPayload(
      new Request('https://x.example/', {
        headers: {
          'sec-ch-ua': '"Chromium";v="126", "Google Chrome";v="126"',
          'sec-ch-ua-platform': '"Windows"',
          'sec-ch-ua-mobile': '?0',
          'accept-language': 'en-US,en;q=0.9',
        },
      })
    );
    expect(payload.headers['sec-ch-ua']).toBe('"Chromium";v="126", "Google Chrome";v="126"');
    expect(payload.headers['sec-ch-ua-platform']).toBe('"Windows"');
    expect(payload.headers['sec-ch-ua-mobile']).toBe('?0');
    expect(payload.headers['accept-language']).toBe('en-US,en;q=0.9');
    expect(payload.headerSet).toBe(FORWARDED_HEADER_SET);
    expect(payload.secure).toBe(true);
    expect(payload.droppedHeaders).toBeUndefined();
  });

  it("reports an http origin as not secure, so a missing hint is never the visitor's", async () => {
    const payload = await extractPayload(new Request('http://x.example/'));
    expect(payload.secure).toBe(false);
  });

  it('drops an oversized hint rather than forwarding a page of it', async () => {
    const payload = await extractPayload(
      new Request('https://x.example/', { headers: { 'accept-language': 'x'.repeat(257) } })
    );
    expect(payload.headers['accept-language']).toBeUndefined();
    // Named as dropped, so the tells read it as present-but-unreadable, never as the visitor's absence.
    expect(payload.droppedHeaders).toContain('accept-language');
    expect(payload.headerSet).toBe(FORWARDED_HEADER_SET);
  });
});

describe('extractPayload by revision', () => {
  const request = (headers: Record<string, string> = {}) =>
    new Request('https://ai.d3.com/', {
      headers: {
        'user-agent': 'Bot/1',
        'x-partner': 'acme',
        'x-api-key': 'k',
        authorization: 'Bearer t',
        cookie: 'plan=pro; sid=s; __Host-d3pay=' + 'a'.repeat(43),
        ...headers,
      },
    });

  it('keeps the allowlist and sends no cookies below revision 2', async () => {
    const payload = await extractPayload(request(), {
      adapterSet: 1,
      exclude: { headers: ['x-api-key'], cookies: [] },
    });
    expect(Object.keys(payload.headers).sort()).toEqual(['d3pay-session', 'user-agent']);
    expect(payload.cookies).toBeUndefined();
    expect(payload.excluded).toBeUndefined();
  });

  it('forwards every header and cookie at revision 2, minus the exclusions, which it echoes', async () => {
    const payload = await extractPayload(request(), {
      adapterSet: 2,
      exclude: { headers: ['x-api-key'], cookies: ['sid'] },
    });
    expect(payload.headers).toMatchObject({ 'user-agent': 'Bot/1', 'x-partner': 'acme' });
    expect(payload.headers['x-api-key']).toBeUndefined();
    expect(payload.headers.authorization).toBeUndefined();
    expect(payload.headers.cookie).toBeUndefined();
    // Our session cookie still rides its own header.
    expect(payload.headers['d3pay-session']).toBe('a'.repeat(43));
    expect(payload.cookies).toEqual({ plan: 'pro' });
    expect(payload.excluded).toEqual({ headers: ['x-api-key'], cookies: ['sid'] });
  });

  it('flags headers as unlisted when the exclusions outgrow the echo', async () => {
    const names = Array.from({ length: 130 }, (_, i) => `x-secret-${i}`);
    const payload = await extractPayload(request({ 'x-secret-129': 'k' }), {
      adapterSet: 2,
      exclude: { headers: names, cookies: [] },
    });
    expect(payload.headers['x-secret-129']).toBeUndefined();
    expect(payload.excluded!.headers).toHaveLength(128);
    expect(payload.droppedUnlisted).toEqual({ headers: true, cookies: false });
  });

  it('echoes nothing when the site excludes nothing', async () => {
    expect((await extractPayload(request(), { adapterSet: 2 })).excluded).toBeUndefined();
  });

  it('reads no MCP call below revision 3, and lifts its payment at 3', async () => {
    const mcp = () =>
      new Request('https://ai.d3.com/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'get_report', _meta: { 'dna.d3.com/key': 'dna_k_1' } },
        }),
      });
    const two = await extractEdgeRequest(mcp(), { adapterSet: 2 });
    expect(two.mcp).toBeNull();
    expect(two.payload.mcp).toBeUndefined();
    expect(two.payload.headers['payment-authorization']).toBeUndefined();

    const three = await extractEdgeRequest(mcp(), { adapterSet: 3 });
    expect(three.payload.mcp).toEqual({ method: 'tools/call', tool: 'get_report', source: 'body' });
    expect(three.payload.headers['payment-authorization']).toBe('Payment dna_k_1');
    expect(JSON.parse(three.mcp!.originBody!).params).toEqual({ name: 'get_report' });
  });

  it('withholds a lifted credential the site excludes, and still strips it from the body', async () => {
    const call = new Request('https://ai.d3.com/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'get_report', _meta: { 'dna.d3.com/key': 'dna_k_1' } },
      }),
    });
    const { payload, mcp } = await extractEdgeRequest(call, {
      adapterSet: 3,
      exclude: { headers: ['payment-authorization'], cookies: [] },
    });
    expect(payload.headers['payment-authorization']).toBeUndefined();
    expect(payload.excluded?.headers).toEqual(['payment-authorization']);
    expect(JSON.parse(mcp!.originBody!).params).toEqual({ name: 'get_report' });
  });

  it('keeps a payment header the client sent over one lifted from the body', async () => {
    const call = new Request('https://ai.d3.com/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'payment-authorization': 'Payment from-header' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { _meta: { 'dna.d3.com/key': 'from-body' } },
      }),
    });
    const { payload } = await extractEdgeRequest(call, { adapterSet: 3 });
    expect(payload.headers['payment-authorization']).toBe('Payment from-header');
  });

  it('never reads an excluded Mcp-* mirror, even when the body is not one call', async () => {
    const batch = new Request('https://ai.d3.com/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'mcp-method': 'tools/call', 'mcp-name': 'secret-tool' },
      body: '[]',
    });
    const { payload } = await extractEdgeRequest(batch, {
      adapterSet: 3,
      exclude: { headers: ['mcp-name'], cookies: [] },
    });
    expect(payload.mcp).toEqual({ method: 'tools/call', source: 'headers' });
    expect(JSON.stringify(payload)).not.toContain('secret-tool');
  });

  it('keeps an x-payment header over an x402 payment in the body: the two names are one credential', async () => {
    const call = new Request('https://ai.d3.com/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-payment': 'eyJ2MSI6dHJ1ZX0=' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { _meta: { 'x402/payment': {} } },
      }),
    });
    const { payload } = await extractEdgeRequest(call, { adapterSet: 3 });
    expect(payload.headers['x-payment']).toBe('eyJ2MSI6dHJ1ZX0=');
    expect(payload.headers['payment-signature']).toBeUndefined();
  });
});

/**
 * The visitor id is ours to set from the cookie and never the client's to
 * assert: a client naming a stranger's id would have the next redemption link
 * that id to their own account (d3-edge ADR 0087 decision 4).
 */
describe('the visitor id header is not the client to write', () => {
  it('is in the never-forwarded set, and defined rather than undefined there', () => {
    expect(VISITOR_ID_HEADER).toBe('d3-visitor');
    expect(NEVER_FORWARDED_HEADERS.has(VISITOR_ID_HEADER)).toBe(true);
    expect(NEVER_FORWARDED_HEADERS.has(undefined as unknown as string)).toBe(false);
  });

  it('drops a client-sent one and keeps the cookie as the only source', async () => {
    const id = ['v'.repeat(22), '1760000000000', 's'.repeat(43)].join('.');
    const forged = await extractPayload(
      new Request('https://x.example/p', { headers: { 'd3-visitor': 'forged-token' } })
    );
    expect(forged.headers['d3-visitor']).toBeUndefined();

    const both = await extractPayload(
      new Request('https://x.example/p', {
        headers: { 'd3-visitor': 'forged-token', cookie: `__Secure-d3visitor=${id}` },
      })
    );
    expect(both.headers['d3-visitor']).toBe(id);
  });
});
