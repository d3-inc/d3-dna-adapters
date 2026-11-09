import { describe, expect, it } from 'vitest';
import {
  FORWARDED_MAX_TOTAL_LENGTH,
  FORWARDED_VALUE_MAX_LENGTH,
  echoedExclusions,
  exclusionOverflowWarning,
  forwardAll,
  NO_EXCLUSIONS,
  parseExclusionList,
  withheldOf,
} from './forward-all';
import { FORWARDED_MAX_NAMES, MCP_DNA_KEY_HEADER, NEVER_FORWARDED_HEADERS } from './forwarding.constants';

const NO_CAPS = new Map<string, number>();

describe('forwardAll', () => {
  it('forwards every header but the never-forwarded, lowercased', () => {
    const headers = new Headers({
      'X-Partner-Id': 'acme',
      'user-agent': 'Bot/1',
      authorization: 'Bearer t',
      'proxy-authorization': 'Basic x',
      connection: 'keep-alive',
      'content-length': '0',
      host: 'a.com',
      [MCP_DNA_KEY_HEADER]: 'dna_k_secret',
    });
    const out = forwardAll(headers, NO_EXCLUSIONS, NO_CAPS);
    expect(out.headers).toEqual({ 'x-partner-id': 'acme', 'user-agent': 'Bot/1' });
    expect(out.droppedHeaders).toEqual([]);
  });

  it('never sends authorization, whatever the site lists', () => {
    expect(NEVER_FORWARDED_HEADERS.has('authorization')).toBe(true);
    const out = forwardAll(new Headers({ authorization: 'Bearer t' }), NO_EXCLUSIONS, NO_CAPS);
    expect(out.headers).toEqual({});
  });

  it('withholds an excluded header and an excluded cookie', () => {
    const out = forwardAll(
      new Headers({ 'x-api-key': 'k', 'x-other': 'o', cookie: 'sid=1; cart=2' }),
      { headers: ['x-api-key'], cookies: ['sid'] },
      NO_CAPS
    );
    expect(out.headers).toEqual({ 'x-other': 'o' });
    expect(out.cookies).toEqual({ cart: '2' });
  });

  it('splits cookies by name, never sends the raw header, and leaves our two cookies to their own headers', () => {
    const out = forwardAll(
      new Headers({ cookie: 'theme=dark; __Host-d3pay=s; __Host-d3person=p; a=b=c' }),
      NO_EXCLUSIONS,
      NO_CAPS
    );
    expect(out.headers).toEqual({});
    expect(out.cookies).toEqual({ theme: 'dark', a: 'b=c' });
  });

  it('drops a value past the default cap and names it', () => {
    const long = 'x'.repeat(FORWARDED_VALUE_MAX_LENGTH + 1);
    const out = forwardAll(
      new Headers({ 'x-long': long, 'x-ok': 'v', cookie: `big=${long}` }),
      NO_EXCLUSIONS,
      NO_CAPS
    );
    expect(out.headers).toEqual({ 'x-ok': 'v' });
    expect(out.droppedHeaders).toEqual(['x-long']);
    expect(out.droppedCookies).toEqual(['big']);
  });

  it('drops the longest values first once the total is over, and names each', () => {
    const value = (n: number) => 'v'.repeat(n);
    const sizeEach = FORWARDED_VALUE_MAX_LENGTH - 10;
    const count = Math.ceil(FORWARDED_MAX_TOTAL_LENGTH / sizeEach) + 1;
    const init: Record<string, string> = { 'x-short': 'tiny' };
    for (let i = 0; i < count; i++) init[`x-h${i}`] = value(sizeEach - i);

    const out = forwardAll(new Headers(init), NO_EXCLUSIONS, NO_CAPS);
    const kept = Object.entries(out.headers).reduce((sum, [n, v]) => sum + n.length + v.length, 0);
    expect(kept).toBeLessThanOrEqual(FORWARDED_MAX_TOTAL_LENGTH);
    expect(out.headers['x-short']).toBe('tiny');
    // x-h0 is the longest, so it goes first.
    expect(out.droppedHeaders[0]).toBe('x-h0');
    expect(out.headers['x-h0']).toBeUndefined();
  });

  it('applies a named cap instead of the default, outside the total', () => {
    const caps = new Map([['x-scitt-receipt', 10_000]]);
    const receipt = 'r'.repeat(9_000);
    const out = forwardAll(new Headers({ 'x-scitt-receipt': receipt }), NO_EXCLUSIONS, caps);
    expect(out.headers['x-scitt-receipt']).toBe(receipt);

    const over = forwardAll(new Headers({ 'x-scitt-receipt': 'r'.repeat(10_001) }), NO_EXCLUSIONS, caps);
    expect(over.droppedHeaders).toEqual(['x-scitt-receipt']);
  });
});

describe('forwardAll, hostile shapes', () => {
  it('keeps the first of a repeated cookie, as the origin reads it', () => {
    expect(
      forwardAll(new Headers({ cookie: 'plan=free; plan=pro' }), NO_EXCLUSIONS, NO_CAPS).cookies
    ).toEqual({
      plan: 'free',
    });
  });

  it('keeps a header or cookie named __proto__ instead of losing it', () => {
    const out = forwardAll(
      new Headers([
        ['__proto__', 'h'],
        ['cookie', '__proto__=c'],
      ]),
      NO_EXCLUSIONS,
      NO_CAPS
    );
    expect(Object.keys(out.headers)).toEqual(['__proto__']);
    expect(Object.keys(out.cookies)).toEqual(['__proto__']);
  });

  it("never sends the platform's own credentials for the site", () => {
    const out = forwardAll(
      new Headers({
        'x-vercel-oidc-token': 'eyJ',
        'cf-access-jwt-assertion': 'eyJ',
        'cf-access-client-secret': 's',
        'x-ok': '1',
      }),
      NO_EXCLUSIONS,
      NO_CAPS
    );
    expect(out.headers).toEqual({ 'x-ok': '1' });
  });
});

describe('exclusionOverflowWarning', () => {
  const names = (n: number) => Array.from({ length: n }, (_, i) => `x-${i}`);

  it('says nothing at the cap, and names each kind past it', () => {
    expect(exclusionOverflowWarning({ headers: names(FORWARDED_MAX_NAMES), cookies: [] })).toBeUndefined();
    expect(exclusionOverflowWarning({ headers: names(FORWARDED_MAX_NAMES + 1), cookies: [] })).toBe(
      `DNA_EXCLUDE_HEADERS lists 129 names, past the 128 DNA is sent: it reads any header a request lacks as kept back, and skips the rules that check one`
    );
    expect(exclusionOverflowWarning({ headers: names(130), cookies: names(129) })).toMatch(
      /^DNA_EXCLUDE_HEADERS lists 130 names.*; DNA_EXCLUDE_COOKIES lists 129 names.*any cookie a request lacks/
    );
  });
});

describe('parseExclusionList', () => {
  it('reads comma-separated names, trimmed, deduplicated, and empty as none', () => {
    expect(parseExclusionList(' A ,b,,a', { lowercase: true })).toEqual(['a', 'b']);
    expect(parseExclusionList('Sid,sid', { lowercase: false })).toEqual(['Sid', 'sid']);
    expect(parseExclusionList(undefined, { lowercase: true })).toEqual([]);
    expect(parseExclusionList('', { lowercase: true })).toEqual([]);
  });

  it('keeps every name past the wire cap, so none of them is forwarded', () => {
    const names = Array.from({ length: FORWARDED_MAX_NAMES + 2 }, (_, i) => `x-secret-${i}`);
    const parsed = parseExclusionList(names.join(','), { lowercase: true });
    expect(parsed).toHaveLength(FORWARDED_MAX_NAMES + 2);

    const last = names[names.length - 1];
    const sent = forwardAll(new Headers({ [last]: 'k' }), { headers: parsed, cookies: [] }, NO_CAPS);
    expect(sent.headers[last]).toBeUndefined();
  });
});

describe('echoedExclusions', () => {
  it('caps each echoed list and flags the kind that overflowed', () => {
    const headers = Array.from({ length: FORWARDED_MAX_NAMES + 1 }, (_, i) => `x-${i}`);
    const echo = echoedExclusions({ headers, cookies: ['sid'] });
    expect(echo.excluded.headers).toHaveLength(FORWARDED_MAX_NAMES);
    expect(echo.excluded.cookies).toEqual(['sid']);
    expect(echo.overflow).toEqual({ headers: true, cookies: false });
  });
});

describe('withheldOf', () => {
  it('says nothing when the site keeps nothing back and every drop is listed', () => {
    expect(withheldOf(NO_EXCLUSIONS, { headers: false, cookies: false })).toEqual({});
  });

  it('echoes the exclusions, and flags a kind whose drops or exclusions outran their lists', () => {
    const many = Array.from({ length: FORWARDED_MAX_NAMES + 1 }, (_, i) => `x-h${i}`);
    const withheld = withheldOf({ headers: many, cookies: ['sid'] }, { headers: false, cookies: true });
    expect(withheld.excluded?.headers).toHaveLength(FORWARDED_MAX_NAMES);
    expect(withheld.excluded?.cookies).toEqual(['sid']);
    expect(withheld.droppedUnlisted).toEqual({ headers: true, cookies: true });
  });
});
