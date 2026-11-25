import { describe, expect, it } from 'vitest';
import { debugHeadersOf, MAX_DEBUG_HEADER_LENGTH, MAX_DEBUG_HEADERS } from './debug-headers';

describe('debugHeadersOf', () => {
  it('keeps every header but the credentials, names lowercased, in arrival order', () => {
    const out = debugHeadersOf([
      ['User-Agent', 'GPTBot/1.0'],
      ['Cookie', 'session=secret'],
      ['Authorization', 'Bearer token'],
      ['Proxy-Authorization', 'Basic x'],
      ['X-Custom', 'v'],
    ]);
    expect(Object.entries(out)).toEqual([
      ['user-agent', 'GPTBot/1.0'],
      ['x-custom', 'v'],
    ]);
  });

  it('drops a value that is not a string or is over the cap, and stops at the count cap', () => {
    expect(
      debugHeadersOf([
        ['x-long', 'a'.repeat(MAX_DEBUG_HEADER_LENGTH + 1)],
        ['x-num', 7],
        ['x-ok', 'v'],
      ])
    ).toEqual({ 'x-ok': 'v' });

    const many: [string, unknown][] = Array.from({ length: MAX_DEBUG_HEADERS + 5 }, (_, i) => [
      `x-${i}`,
      'v',
    ]);
    expect(Object.keys(debugHeadersOf(many))).toHaveLength(MAX_DEBUG_HEADERS);
  });
});
