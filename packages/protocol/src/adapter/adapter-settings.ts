import { edgeLogger } from '../logging/logger';
import { exclusionOverflowWarning, parseExclusionList, type ForwardExclusions } from './forward-all';
import { DEFAULT_PAYMENT_TIMEOUT_MS, DEFAULT_POLICY_TIMEOUT_MS } from './http-policy-client';

export const DEFAULT_DNA_ENDPOINT = 'https://edge-api.d3.com/v1/decision';

const log = edgeLogger('adapter-settings');

/** Settings are read on every request; a warning about them is said once per isolate. */
const warned = new Set<string>();

// Current name first. The later names predate the DNA_ prefix and are still
// read, so an install configured with them keeps working unchanged.
const ADAPTER_SETTING_NAMES = {
  apiKey: ['DNA_API_KEY', 'POLICY_ADAPTER_KEY', 'POLICY_SHARED_SECRET'],
  endpoint: ['DNA_ENDPOINT', 'POLICY_WORKER_URL'],
  enabled: ['DNA_ENABLED'],
  failMode: ['DNA_FAIL_MODE', 'FAIL_MODE'],
  timeoutMs: ['DNA_TIMEOUT_MS', 'POLICY_TIMEOUT_MS'],
  paymentTimeoutMs: ['DNA_PAYMENT_TIMEOUT_MS', 'POLICY_PAYMENT_TIMEOUT_MS'],
  debugLogRawPayload: ['DNA_DEBUG_LOG_RAW_PAYLOAD', 'DEBUG_LOG_RAW_PAYLOAD'],
  excludeHeaders: ['DNA_EXCLUDE_HEADERS'],
  excludeCookies: ['DNA_EXCLUDE_COOKIES'],
} as const;

type SettingNames = typeof ADAPTER_SETTING_NAMES;
export type AdapterSettingName = SettingNames[keyof SettingNames][number];

/** Reads one setting by its env-var name; `undefined` when unset. */
export type SettingLookup = (name: AdapterSettingName) => string | undefined;

export interface AdapterSettings {
  /** The decision URL; `undefined` means DNA is off and traffic passes untouched. */
  endpoint?: string;
  apiKey?: string;
  failMode: 'open' | 'closed';
  timeoutMs: number;
  paymentTimeoutMs: number;
  debugLogRawPayload: boolean;
  /** Comma-separated in the environment; header names compare lowercase, cookie names as sent. */
  exclude: ForwardExclusions;
}

interface FoundSetting {
  name: AdapterSettingName;
  value: string;
}

/**
 * Resolves an adapter's settings from one or more sources, earlier sources
 * winning per setting. An empty value counts as unset, except for the
 * endpoint, where empty is the off switch.
 */
export function readAdapterSettings(...sources: SettingLookup[]): AdapterSettings {
  const names = ADAPTER_SETTING_NAMES;
  const read = (candidates: readonly AdapterSettingName[]): string | undefined =>
    firstNonEmpty(sources, candidates)?.value;
  const endpoint = firstPresent(sources, names.endpoint);
  const hasPolicyWorkerUrl = firstPresent(sources, ['POLICY_WORKER_URL']) !== undefined;
  const apiKey = firstNonEmpty(sources, names.apiKey);
  // A host app's own DEBUG_LOG_RAW_PAYLOAD would forward every header to us, so
  // that generic name counts only on an install still using POLICY_WORKER_URL.
  // FAIL_MODE stays read everywhere: ignoring it could only ever loosen it.
  const debugNames = hasPolicyWorkerUrl ? names.debugLogRawPayload : (['DNA_DEBUG_LOG_RAW_PAYLOAD'] as const);

  const exclude = {
    headers: parseExclusionList(read(names.excludeHeaders), { lowercase: true }),
    cookies: parseExclusionList(read(names.excludeCookies), { lowercase: false }),
  };
  const overflow = exclusionOverflowWarning(exclude);
  if (overflow !== undefined && !warned.has(overflow)) {
    warned.add(overflow);
    log.warn(overflow);
  }

  return {
    endpoint: dnaEndpoint({
      endpoint: endpoint?.value,
      hasDnaApiKey: apiKey?.name === 'DNA_API_KEY',
      enabled: read(names.enabled),
    }),
    apiKey: apiKey?.value,
    failMode: read(names.failMode) === 'closed' ? 'closed' : 'open',
    timeoutMs: positiveNumber(read(names.timeoutMs), DEFAULT_POLICY_TIMEOUT_MS),
    paymentTimeoutMs: positiveNumber(read(names.paymentTimeoutMs), DEFAULT_PAYMENT_TIMEOUT_MS),
    debugLogRawPayload: read(debugNames) === 'true',
    exclude,
  };
}

/**
 * The on switch. Only `DNA_API_KEY` switches DNA on by itself, never the older
 * key names: an install that predates it may hold `POLICY_ADAPTER_KEY` with the
 * URL unset precisely to stay off.
 */
export function dnaEndpoint(input: {
  endpoint?: string;
  hasDnaApiKey: boolean;
  enabled?: string;
}): string | undefined {
  if (input.enabled?.trim().toLowerCase() === 'false') return undefined;

  if (input.endpoint !== undefined) return input.endpoint || undefined;
  return input.hasDnaApiKey ? DEFAULT_DNA_ENDPOINT : undefined;
}

// For the endpoint, where an empty value is the off switch and so counts.
function firstPresent(
  sources: SettingLookup[],
  names: readonly AdapterSettingName[]
): FoundSetting | undefined {
  return firstMatching(sources, names, () => true);
}

function firstNonEmpty(
  sources: SettingLookup[],
  names: readonly AdapterSettingName[]
): FoundSetting | undefined {
  return firstMatching(sources, names, (value) => value !== '');
}

function firstMatching(
  sources: SettingLookup[],
  names: readonly AdapterSettingName[],
  counts: (value: string) => boolean
): FoundSetting | undefined {
  for (const source of sources) {
    for (const name of names) {
      const value = source(name);
      if (value !== undefined && counts(value)) return { name, value };
    }
  }

  return undefined;
}

function positiveNumber(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
