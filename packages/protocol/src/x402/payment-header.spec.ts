import { describe, expect, it } from 'vitest';
import { PAYMENT_AUTHORIZATION_MAX_LENGTH, PAY_SESSION_MAX_LENGTH } from '../pay-session';
import {
  X402_MAX_PAYMENT_HEADER_LENGTH,
  hasPaymentHeader,
  requestPresentsPayment,
  stripPaymentHeaders,
} from './payment-header';

const SESSION = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

describe('hasPaymentHeader', () => {
  it('is true for either x402 header or the pay credential alone, under their caps', () => {
    expect(hasPaymentHeader({ 'payment-signature': 'eyJ4IjoxfQ==' })).toBe(true);
    expect(hasPaymentHeader(new Headers({ 'x-payment': 'eyJ4IjoxfQ==' }))).toBe(true);
    expect(hasPaymentHeader({ 'payment-authorization': `Payment ${SESSION}` })).toBe(true);
  });

  it('is true for our cookie on a real request and for the forwarded header on a payload', () => {
    expect(hasPaymentHeader(new Headers({ cookie: `theme=dark; __Host-d3pay=${SESSION}` }))).toBe(true);
    expect(hasPaymentHeader({ 'd3pay-session': SESSION })).toBe(true);
  });

  it('is false for nothing, an empty value, a stranger cookie, the browser-check pass, and a value past its own cap', () => {
    expect(hasPaymentHeader({})).toBe(false);
    expect(hasPaymentHeader(new Headers({ cookie: '__Host-d3person=1.sig' }))).toBe(false);
    expect(hasPaymentHeader({ 'd3pay-person': '1.sig' })).toBe(false);
    expect(hasPaymentHeader({ 'payment-authorization': '' })).toBe(false);
    expect(hasPaymentHeader(new Headers({ cookie: 'session=abc; d3pay=x' }))).toBe(false);
    expect(
      hasPaymentHeader(new Headers({ cookie: `__Host-d3pay=${'x'.repeat(PAY_SESSION_MAX_LENGTH + 1)}` }))
    ).toBe(false);
    expect(
      hasPaymentHeader({ 'payment-authorization': 'x'.repeat(PAYMENT_AUTHORIZATION_MAX_LENGTH + 1) })
    ).toBe(false);
    expect(hasPaymentHeader({ 'payment-signature': 'x'.repeat(X402_MAX_PAYMENT_HEADER_LENGTH + 1) })).toBe(
      false
    );
  });
});

describe('requestPresentsPayment', () => {
  const handoff = `${'a'.repeat(22)}.${'b'.repeat(43)}`;

  it('sees a credential in a header, in our cookie and on the URL alike', () => {
    expect(
      requestPresentsPayment(new Request('https://ai.d3.com/p', { headers: { 'x-payment': 'abc' } }))
    ).toBe(true);
    expect(
      requestPresentsPayment(
        new Request('https://ai.d3.com/p', { headers: { cookie: `__Host-d3pay=${SESSION}` } })
      )
    ).toBe(true);
    // The redemption's only credential: missed here, it is answered on the
    // unpaid budget and blocked when the charge overruns it.
    expect(requestPresentsPayment(new Request(`https://ai.d3.com/p?d3pay_handoff=${handoff}`))).toBe(true);
    expect(requestPresentsPayment(new Request(`https://ai.d3.com/p?a=1&d3pay_handoff=${handoff}&b=2`))).toBe(
      true
    );
  });

  it('is false for a plain request, a stranger cookie and a malformed handoff', () => {
    expect(requestPresentsPayment(new Request('https://ai.d3.com/p'))).toBe(false);
    expect(requestPresentsPayment(new Request('https://ai.d3.com/p', { headers: { cookie: 'a=1' } }))).toBe(
      false
    );
    expect(requestPresentsPayment(new Request('https://ai.d3.com/p?d3pay_handoff=nope'))).toBe(false);
  });
});

describe('stripPaymentHeaders', () => {
  it('removes every payment header and keeps the rest', () => {
    const request = new Request('https://ai.d3.com/premium', {
      headers: {
        'payment-authorization': `Payment ${SESSION}`,
        'payment-signature': 'abc',
        'x-payment': 'def',
        'd3pay-session': SESSION,
        'user-agent': 'agent',
      },
    });
    const stripped = stripPaymentHeaders(request);
    expect(stripped.headers.get('payment-authorization')).toBeNull();
    expect(stripped.headers.get('payment-signature')).toBeNull();
    expect(stripped.headers.get('x-payment')).toBeNull();
    expect(stripped.headers.get('d3pay-session')).toBeNull();
    expect(stripped.headers.get('user-agent')).toBe('agent');
    expect(stripped.url).toBe(request.url);
  });

  it('removes only our cookies from the Cookie header, and the header when they were alone', () => {
    const shared = stripPaymentHeaders(
      new Request('https://ai.d3.com/premium', {
        headers: { cookie: `theme=dark; __Host-d3pay=${SESSION}; __Host-d3person=1.sig; a=b` },
      })
    );
    expect(shared.headers.get('cookie')).toBe('theme=dark; a=b');

    const person = stripPaymentHeaders(
      new Request('https://ai.d3.com/premium', { headers: { cookie: '__Host-d3person=1.sig' } })
    );
    expect(person.headers.get('cookie')).toBeNull();

    const alone = stripPaymentHeaders(
      new Request('https://ai.d3.com/premium', { headers: { cookie: `__Host-d3pay=${SESSION}` } })
    );
    expect(alone.headers.get('cookie')).toBeNull();
  });

  it('removes the browser-check pass header, which is a credential even though it is not a payment', () => {
    const stripped = stripPaymentHeaders(
      new Request('https://ai.d3.com/premium', {
        headers: { 'd3pay-person': '1760000000000.sig', 'user-agent': 'agent' },
      })
    );
    expect(stripped.headers.get('d3pay-person')).toBeNull();
    expect(stripped.headers.get('user-agent')).toBe('agent');
  });

  it('returns the request itself when there is nothing to strip', () => {
    const request = new Request('https://ai.d3.com/page', {
      headers: { 'user-agent': 'agent', cookie: 'session=abc' },
    });
    expect(stripPaymentHeaders(request)).toBe(request);
  });
});

describe('stripPaymentHeaders and the URL', () => {
  it('drops a redeemed handoff and a browser check from the query string, keeping everything else', () => {
    const clean = stripPaymentHeaders(
      new Request('https://ai.d3.com/premium?lang=en&d3pay_handoff=abc.def&d3pay_check=approved.1.sig&page=2')
    );
    expect(clean.url).toBe('https://ai.d3.com/premium?lang=en&page=2');
    expect(stripPaymentHeaders(new Request('https://ai.d3.com/premium?d3pay_browser=abc&page=2')).url).toBe(
      'https://ai.d3.com/premium?page=2'
    );
  });

  it('is the same request when there is nothing to strip', () => {
    const request = new Request('https://ai.d3.com/premium?lang=en');
    expect(stripPaymentHeaders(request)).toBe(request);
  });
});
