import { describe, expect, it } from 'vitest';
import {
  ADAPTER_NAME_MAX_LENGTH,
  ADAPTER_TYPE_ENDPOINTS,
  adapterNameOf,
  callsEndpoint,
  compareAdapterVersions,
  isAdapterType,
  isAdapterVersion,
  parseAdapterName,
} from './adapter-name';

describe('parseAdapterName', () => {
  it.each([
    ['cloudflare:0.10.1', 'cloudflare', '0.10.1'],
    ['caddy:1.0.0-next.1', 'caddy', '1.0.0-next.1'],
    ['cloudflare:0.10.1+5ac94a8', 'cloudflare', '0.10.1+5ac94a8'],
    ['my-proxy:2.0.0', 'my-proxy', '2.0.0'],
  ])('reads %s', (value, type, version) => {
    expect(parseAdapterName(value)).toEqual({ type, version });
  });

  it('fits the longest type with a pre-release and a 12-character commit', () => {
    expect(parseAdapterName(`vercel-middleware:10.10.10-next.10+${'f'.repeat(12)}`)).not.toBeNull();
  });

  it('reads a value at the cap and drops one past it', () => {
    const atCap = `x:1.0.0+${'a'.repeat(ADAPTER_NAME_MAX_LENGTH - 8)}`;
    expect(atCap).toHaveLength(ADAPTER_NAME_MAX_LENGTH);
    expect(parseAdapterName(atCap)).not.toBeNull();
    expect(parseAdapterName(`${atCap}a`)).toBeNull();
  });

  it.each([
    ['no header', null],
    ['no colon', 'cloudflare'],
    ['an empty type', ':1.0.0'],
    ['an uppercase type', 'Cloudflare:1.0.0'],
    ['a type with an underscore', 'cloud_flare:1.0.0'],
    ['a type with a dot', 'cloud.flare:1.0.0'],
    ['a type with a space', 'cloud flare:1.0.0'],
    ['an empty version', 'caddy:'],
    ['two parts', 'caddy:1.0'],
    ['a leading v', 'caddy:v1.0.0'],
    ['a leading zero', 'caddy:01.0.0'],
    ['an empty pre-release', 'caddy:1.0.0-'],
    ['empty build metadata', 'caddy:1.0.0+'],
    ['a second colon', 'caddy:1.0.0:2'],
    ['a space in the version', 'caddy:1.0.0 beta'],
  ])('drops %s', (_, value) => {
    expect(parseAdapterName(value)).toBeNull();
  });
});

describe('adapterNameOf', () => {
  it('names a build by its type and version', () => {
    expect(adapterNameOf('cloudflare', '0.11.0')).toBe('cloudflare:0.11.0');
    expect(adapterNameOf('cloudflare', '0.10.1+5ac94a8')).toBe('cloudflare:0.10.1+5ac94a8');
  });

  it.each([
    ['no version', undefined],
    ['a v prefix', 'v0.11.0'],
    ['git describe output with a v', 'v0.10.1-3-g5ac94a8'],
    ['a value past the cap', `0.11.0+${'a'.repeat(60)}`],
  ])('names nothing for %s', (_name, version) => {
    expect(adapterNameOf('vercel-middleware', version)).toBeUndefined();
  });
});

describe('ADAPTER_TYPE_ENDPOINTS', () => {
  it('names every type the way the parser reads one', () => {
    for (const type of Object.keys(ADAPTER_TYPE_ENDPOINTS)) {
      expect(parseAdapterName(`${type}:1.0.0`)?.type).toBe(type);
    }
  });
});

describe('isAdapterVersion', () => {
  it.each(['0.10.1', '0.10.1-next.1', '0.10.1+5ac94a8'])('takes %s', (version) => {
    expect(isAdapterVersion(version)).toBe(true);
  });

  it.each(['0.10', 'v0.10.1', '01.0.0', ''])(
    'refuses %s, which compareAdapterVersions would misorder',
    (version) => {
      expect(isAdapterVersion(version)).toBe(false);
    }
  );
});

describe('isAdapterType', () => {
  it('takes each type we publish and nothing it inherits', () => {
    expect(isAdapterType('openresty')).toBe(true);
    expect(isAdapterType('my-proxy')).toBe(false);
    expect(isAdapterType('constructor')).toBe(false);
    expect(isAdapterType('toString')).toBe(false);
  });
});

describe('callsEndpoint', () => {
  it('places a type on the routes it calls', () => {
    expect(callsEndpoint('cloudflare', 'decision')).toBe(true);
    expect(callsEndpoint('cloudflare', 'fleet')).toBe(true);
    expect(callsEndpoint('caddy', 'forward-auth')).toBe(true);
  });

  it('refuses a type on a route it never calls', () => {
    expect(callsEndpoint('cloudflare', 'forward-auth')).toBe(false);
    expect(callsEndpoint('vercel-mcp', 'forward-auth')).toBe(false);
    expect(callsEndpoint('caddy', 'decision')).toBe(false);
    expect(callsEndpoint('nginx', 'fleet')).toBe(false);
  });

  it('refuses a type we do not publish, including inherited keys', () => {
    expect(callsEndpoint('my-proxy', 'decision')).toBe(false);
    expect(callsEndpoint('constructor', 'decision')).toBe(false);
    expect(callsEndpoint('__proto__', 'decision')).toBe(false);
  });
});

describe('compareAdapterVersions', () => {
  it('orders semver.org precedence example, lowest first', () => {
    const ordered = [
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.beta',
      '1.0.0-beta',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0-rc.1',
      '1.0.0',
    ];
    for (let i = 1; i < ordered.length; i += 1) {
      expect(compareAdapterVersions(ordered[i - 1], ordered[i])).toBeLessThan(0);
      expect(compareAdapterVersions(ordered[i], ordered[i - 1])).toBeGreaterThan(0);
    }
  });

  it('compares each part as a number, not text', () => {
    expect(compareAdapterVersions('0.9.9', '0.10.0')).toBeLessThan(0);
    expect(compareAdapterVersions('2.0.0', '10.0.0')).toBeLessThan(0);
    expect(compareAdapterVersions('1.0.0-next.9', '1.0.0-next.10')).toBeLessThan(0);
  });

  it('ignores build metadata', () => {
    expect(compareAdapterVersions('0.10.1+5ac94a8', '0.10.1')).toBe(0);
    expect(compareAdapterVersions('0.10.1+aaa', '0.10.1+bbb')).toBe(0);
    expect(compareAdapterVersions('0.10.1-next.1+aaa', '0.10.1')).toBeLessThan(0);
  });

  it('orders numbers past 2^53 by their digits', () => {
    expect(compareAdapterVersions('9007199254740993.0.0', '9007199254740992.0.0')).toBeGreaterThan(0);
  });

  it('reads equal versions as equal', () => {
    expect(compareAdapterVersions('1.2.3-rc.1', '1.2.3-rc.1')).toBe(0);
  });
});
