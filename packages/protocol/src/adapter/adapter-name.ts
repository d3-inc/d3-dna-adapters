/** Every call carries `<type>:<version>` here, on both dialects. */
export const DNA_ADAPTER_HEADER = 'dna-adapter';

export const ADAPTER_NAME_MAX_LENGTH = 64;

/** The endpoint's routes, as its request record names them. */
export type AdapterEndpoint = 'decision' | 'fleet' | 'forward-auth';

/**
 * Each integration we publish, and the routes it calls. `fleet` is the
 * Cloudflare adapter reaching the endpoint over a service binding.
 */
export const ADAPTER_TYPE_ENDPOINTS = {
  cloudflare: ['decision', 'fleet'],
  'vercel-middleware': ['decision'],
  'vercel-mcp': ['decision'],
  snippet: ['decision'],
  openresty: ['decision'],
  caddy: ['forward-auth'],
  nginx: ['forward-auth'],
} as const satisfies Record<string, readonly AdapterEndpoint[]>;

export type AdapterType = keyof typeof ADAPTER_TYPE_ENDPOINTS;

/** `type` is any well-formed name, ours or not: the record keeps an unknown one too. */
export interface AdapterName {
  type: string;
  version: string;
}

const ADAPTER_TYPE = /^[a-z0-9-]+$/;

// semver.org's pattern. The length cap runs first, which bounds its backtracking.
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/** The type and version a `dna-adapter` value names, or null for the whole value when any part is malformed. */
export function parseAdapterName(value: string | null): AdapterName | null {
  if (value === null || value.length > ADAPTER_NAME_MAX_LENGTH) return null;

  const colon = value.indexOf(':');
  if (colon === -1) return null;

  const type = value.slice(0, colon);
  const version = value.slice(colon + 1);
  if (!ADAPTER_TYPE.test(type) || !isAdapterVersion(version)) return null;

  return { type, version };
}

/** Whether `compareAdapterVersions` can order it: semver, no leading `v`. */
export function isAdapterVersion(version: string): boolean {
  return SEMVER.test(version);
}

/** Own keys only, so `constructor` and the like never index the table. */
export function isAdapterType(type: string): type is AdapterType {
  return Object.hasOwn(ADAPTER_TYPE_ENDPOINTS, type);
}

/** False for a type we don't publish, and for one of ours on a route it never calls. */
export function callsEndpoint(type: string, endpoint: AdapterEndpoint): boolean {
  if (!isAdapterType(type)) return false;

  const endpoints: readonly AdapterEndpoint[] = ADAPTER_TYPE_ENDPOINTS[type];
  return endpoints.includes(endpoint);
}

/**
 * Semver precedence, negative when `a` sorts first: `0.9.9` below `0.10.0`,
 * `1.0.0-next.1` below `1.0.0`, and build metadata ignored. Both must pass
 * `isAdapterVersion`: `1.0` throws, and `v1.0.0` sorts wrong.
 */
export function compareAdapterVersions(a: string, b: string): number {
  const [coreA, preA] = splitVersion(a);
  const [coreB, preB] = splitVersion(b);

  for (let i = 0; i < 3; i += 1) {
    const order = compareNumeric(coreA[i], coreB[i]);
    if (order !== 0) return order;
  }

  if (preA.length === 0 || preB.length === 0) return preB.length - preA.length;

  for (let i = 0; i < Math.min(preA.length, preB.length); i += 1) {
    const order = comparePrerelease(preA[i], preB[i]);
    if (order !== 0) return order;
  }

  return preA.length - preB.length;
}

function splitVersion(version: string): [string[], string[]] {
  const withoutBuild = version.split('+', 1)[0];
  const dash = withoutBuild.indexOf('-');
  const core = dash === -1 ? withoutBuild : withoutBuild.slice(0, dash);
  const prerelease = dash === -1 ? [] : withoutBuild.slice(dash + 1).split('.');
  return [core.split('.'), prerelease];
}

const NUMERIC = /^\d+$/;

// Semver forbids leading zeros, so a longer digit string is the larger number,
// with no precision lost past 2^53.
function compareNumeric(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  return compareAscii(a, b);
}

function comparePrerelease(a: string, b: string): number {
  const aNumeric = NUMERIC.test(a);
  const bNumeric = NUMERIC.test(b);
  if (aNumeric && bNumeric) return compareNumeric(a, b);

  if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
  return compareAscii(a, b);
}

function compareAscii(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
