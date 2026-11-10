import { describe, expect, it } from 'vitest';
import { isNamespaceCookie, isNamespaceParam } from './namespace';
import {
  BROWSER_CHECK_PARAM,
  OWN_COOKIES,
  PAY_AUTH_CHECK_PARAM,
  PAY_HANDOFF_PARAM,
  PAY_SESSION_COOKIE,
  PERSON_PASS_COOKIE,
} from './pay-session';

describe('isNamespaceCookie', () => {
  it('holds every cookie the endpoint sets', () => {
    for (const name of [...OWN_COOKIES, PAY_SESSION_COOKIE, PERSON_PASS_COOKIE, '__Secure-d3visitor']) {
      expect(isNamespaceCookie(name)).toBe(true);
    }
  });

  it.each([
    ['the dashboard', '__Host-d3_acquisition'],
    ['the admin app', '__Secure-d3-admin.session_token'],
    ['nothing after the prefix', '__Host-d3'],
    ['an uppercase letter after it', '__Host-d3Pay'],
    ['a lowercase prefix', '__host-d3pay'],
    ['no cookie prefix', 'd3pay'],
    ['a prefix mid-name', 'x__Host-d3pay'],
    ['an untrimmed name, which callers trim first', ' __Host-d3pay'],
  ])('leaves out %s', (_, name) => {
    expect(isNamespaceCookie(name)).toBe(false);
  });
});

describe('isNamespaceParam', () => {
  it('holds every param the endpoint rides back on', () => {
    for (const name of [PAY_HANDOFF_PARAM, PAY_AUTH_CHECK_PARAM, BROWSER_CHECK_PARAM]) {
      expect(isNamespaceParam(name)).toBe(true);
    }
  });

  it.each(['d3pay', 'D3PAY_handoff', 'xd3pay_handoff', 'from', 'd3pay%5Fhandoff'])(
    'leaves out %s',
    (name) => {
      expect(isNamespaceParam(name)).toBe(false);
    }
  );
});
