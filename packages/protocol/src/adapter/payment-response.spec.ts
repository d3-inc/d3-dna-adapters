import { describe, expect, it } from 'vitest';
import {
  buildPaymentResponse,
  headerSafePaymentHeaders,
  paymentEdgeMode,
  privateCacheControl,
  withPaymentHeaders,
} from './payment-response';

const CRLF = String.fromCharCode(13, 10);

describe('headerSafePaymentHeaders', () => {
  it('drops a value that would inject a second header', () => {
    const safe = headerSafePaymentHeaders({ ok: 'fine', bad: `a${CRLF}Set-Cookie: x` });
    expect(safe).toEqual({ ok: 'fine' });
  });

  it('drops a value a Headers object would throw on, or that has no bound', () => {
    expect(headerSafePaymentHeaders({ bad: 'Tether₮' })).toEqual({});
    expect(headerSafePaymentHeaders({ bad: 'a'.repeat(8193) })).toEqual({});
    expect(headerSafePaymentHeaders({ bad: '' })).toEqual({});
  });

  it('drops a name that is not a header name', () => {
    expect(headerSafePaymentHeaders({ 'bad name': 'v', 'bad:name': 'v' })).toEqual({});
  });

  it('keeps the names the protocol actually uses', () => {
    const headers = { 'payment-required': 'eyJ4IjoxfQ==', 'access-control-expose-headers': 'x' };
    expect(headerSafePaymentHeaders(headers)).toEqual(headers);
  });

  it('is empty for nothing at all', () => {
    expect(headerSafePaymentHeaders(undefined)).toEqual({});
  });
});

describe('buildPaymentResponse', () => {
  it('answers with the status and body it was handed, and never caches it', () => {
    const res = buildPaymentResponse({ status: 402, body: '{"x":1}' }, 'payment-required');
    expect(res.status).toBe(402);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-d3-edge')).toBe('payment-required');
  });

  it('does not let a handed header overwrite the outcome tag', () => {
    const res = buildPaymentResponse({ status: 402, headers: { 'x-d3-edge': 'pass' } }, 'payment-required');
    expect(res.headers.get('x-d3-edge')).toBe('payment-required');
  });

  it('answers an empty body when there is nothing to say', async () => {
    const res = buildPaymentResponse({ status: 502 }, 'fail-closed');
    expect(res.status).toBe(502);
    expect(await res.text()).toBe('');
  });
});

describe('withPaymentHeaders', () => {
  it('returns the origin response untouched when there is nothing to add', () => {
    const origin = new Response('hi');
    expect(withPaymentHeaders(origin, undefined)).toBe(origin);
    expect(withPaymentHeaders(origin, { headers: {} })).toBe(origin);
  });

  it('copies a receipt onto a response whose headers are immutable', async () => {
    const origin = new Response('hi', { headers: { 'content-type': 'text/plain' } });
    const withReceipt = withPaymentHeaders(origin, { headers: { 'payment-response': 'abc' } });

    expect(withReceipt.headers.get('payment-response')).toBe('abc');
    expect(withReceipt.headers.get('content-type')).toBe('text/plain');
    expect(await withReceipt.text()).toBe('hi');
  });

  it('adds to the origin CORS list rather than replacing it', () => {
    // `set` here would revoke a browser's access to headers the origin
    // deliberately exposed, on every settled cross-origin response.
    const origin = new Response('hi', { headers: { 'access-control-expose-headers': 'x-request-id' } });
    const withReceipt = withPaymentHeaders(origin, {
      headers: { 'payment-response': 'abc', 'access-control-expose-headers': 'payment-response' },
    });

    const exposed = withReceipt.headers.get('access-control-expose-headers') ?? '';
    expect(exposed).toContain('x-request-id');
    expect(exposed).toContain('payment-response');
  });

  it('still sets the CORS list when the origin declared none', () => {
    const withReceipt = withPaymentHeaders(new Response('hi'), {
      headers: { 'access-control-expose-headers': 'payment-response' },
    });

    expect(withReceipt.headers.get('access-control-expose-headers')).toBe('payment-response');
  });

  it('appends our Set-Cookie after the origin cookie rather than replacing it', () => {
    const origin = new Response('hi', { headers: { 'set-cookie': 'site=1; Path=/' } });
    const passed = withPaymentHeaders(origin, {
      headers: { 'set-cookie': '__Host-d3pay=t; Path=/; Secure' },
    });

    expect(passed.headers.getSetCookie()).toEqual(['site=1; Path=/', '__Host-d3pay=t; Path=/; Secure']);
  });

  it("keeps the origin's freshness directives and narrows the response to one browser", () => {
    const origin = new Response('paid bytes', {
      headers: { 'cache-control': 'public, max-age=0, must-revalidate' },
    });
    const passed = withPaymentHeaders(origin, { headers: { 'payment-receipt': 'eyJvayI6dHJ1ZX0' } });

    expect(passed.headers.get('cache-control')).toBe('private, max-age=0, must-revalidate');
    expect(passed.headers.get('payment-receipt')).toBe('eyJvayI6dHJ1ZX0');
  });

  it('keeps a session cookie out of a shared cache on a public origin', () => {
    const origin = new Response('paid bytes', { headers: { 'cache-control': 'public, max-age=3600' } });
    const passed = withPaymentHeaders(origin, {
      headers: { 'payment-receipt': 'eyJvayI6dHJ1ZX0', 'set-cookie': '__Host-d3pay=t; Secure' },
    });

    expect(passed.headers.get('cache-control')).toBe('private, max-age=3600');
  });
});

describe('privateCacheControl', () => {
  it('narrows a shared cache out and never widens what the origin allowed', () => {
    expect(privateCacheControl(null)).toBe('private');
    expect(privateCacheControl('')).toBe('private');
    expect(privateCacheControl('public')).toBe('private');
    expect(privateCacheControl('public, max-age=600')).toBe('private, max-age=600');
    expect(privateCacheControl('max-age=600')).toBe('private, max-age=600');
    expect(privateCacheControl('PUBLIC, s-maxage=60')).toBe('private, s-maxage=60');
  });

  it('leaves a policy that is already at least as private untouched', () => {
    expect(privateCacheControl('no-store')).toBe('no-store');
    expect(privateCacheControl('private, max-age=0')).toBe('private, max-age=0');
    expect(privateCacheControl('no-cache, no-store, must-revalidate')).toBe(
      'no-cache, no-store, must-revalidate'
    );
  });
});

describe('paymentEdgeMode', () => {
  it('names the three outcomes an instruction can carry', () => {
    expect(paymentEdgeMode(402)).toBe('payment-required');
    expect(paymentEdgeMode(302)).toBe('payment-redirect');
    expect(paymentEdgeMode(307)).toBe('payment-redirect');
    expect(paymentEdgeMode(200)).toBe('payment-stub');
    expect(paymentEdgeMode(502)).toBe('fail-closed');
  });
});

describe('buildPaymentResponse for a redirect', () => {
  it('carries the location and no JSON content-type', () => {
    const response = buildPaymentResponse(
      { status: 302, headers: { location: 'https://pay.example/?back=x' } },
      'payment-redirect'
    );
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://pay.example/?back=x');
    expect(response.headers.get('content-type')).toBeNull();
    expect(response.headers.get('x-d3-edge')).toBe('payment-redirect');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});
