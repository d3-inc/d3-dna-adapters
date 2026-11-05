import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DNA_ENDPOINT,
  dnaEndpoint,
  readAdapterSettings,
  type SettingLookup,
} from './adapter-settings';
import { DEFAULT_PAYMENT_TIMEOUT_MS, DEFAULT_POLICY_TIMEOUT_MS } from './http-policy-client';

const KEY = 'd3_k_new';
const OLD_KEY = 'd3_k_old';
const CUSTOM = 'https://edge-api.example/v1/decision';

const from =
  (vars: Record<string, string | undefined>): SettingLookup =>
  (name) =>
    vars[name];

describe('dnaEndpoint', () => {
  it('should call the default endpoint when a DNA_API_KEY is all there is', () => {
    expect(dnaEndpoint({ hasDnaApiKey: true })).toBe(DEFAULT_DNA_ENDPOINT);
  });

  it('should call a named endpoint, with or without a key', () => {
    expect(dnaEndpoint({ endpoint: CUSTOM, hasDnaApiKey: true })).toBe(CUSTOM);
    expect(dnaEndpoint({ endpoint: CUSTOM, hasDnaApiKey: false })).toBe(CUSTOM);
  });

  it('should stay off with neither a key nor an endpoint', () => {
    expect(dnaEndpoint({ hasDnaApiKey: false })).toBeUndefined();
  });

  it('should stay off on an empty endpoint even with a key', () => {
    expect(dnaEndpoint({ endpoint: '', hasDnaApiKey: true })).toBeUndefined();
  });

  it('should stay off under DNA_ENABLED=false, in any case, whatever else is set', () => {
    expect(dnaEndpoint({ hasDnaApiKey: true, enabled: 'false' })).toBeUndefined();
    expect(dnaEndpoint({ endpoint: CUSTOM, hasDnaApiKey: false, enabled: ' FALSE ' })).toBeUndefined();
  });

  it('should ignore any DNA_ENABLED value but false', () => {
    expect(dnaEndpoint({ hasDnaApiKey: true, enabled: 'true' })).toBe(DEFAULT_DNA_ENDPOINT);
    expect(dnaEndpoint({ hasDnaApiKey: true, enabled: 'no' })).toBe(DEFAULT_DNA_ENDPOINT);
  });
});

describe('readAdapterSettings', () => {
  it('should switch on from DNA_API_KEY alone', () => {
    const s = readAdapterSettings(from({ DNA_API_KEY: KEY }));
    expect(s.endpoint).toBe(DEFAULT_DNA_ENDPOINT);
    expect(s.apiKey).toBe(KEY);
  });

  it('should leave a legacy key with no URL switched off, as it was before DNA_API_KEY', () => {
    expect(readAdapterSettings(from({ POLICY_ADAPTER_KEY: OLD_KEY })).endpoint).toBeUndefined();
    expect(readAdapterSettings(from({ POLICY_SHARED_SECRET: OLD_KEY })).endpoint).toBeUndefined();
  });

  it('should run a legacy install exactly as configured', () => {
    const s = readAdapterSettings(
      from({
        POLICY_WORKER_URL: CUSTOM,
        POLICY_ADAPTER_KEY: OLD_KEY,
        POLICY_TIMEOUT_MS: '700',
        POLICY_PAYMENT_TIMEOUT_MS: '9000',
        FAIL_MODE: 'closed',
        DEBUG_LOG_RAW_PAYLOAD: 'true',
      })
    );
    expect(s).toEqual({
      endpoint: CUSTOM,
      apiKey: OLD_KEY,
      timeoutMs: 700,
      paymentTimeoutMs: 9000,
      failMode: 'closed',
      debugLogRawPayload: true,
      exclude: { headers: [], cookies: [] },
    });
  });

  it('should keep the empty legacy URL as an off switch', () => {
    expect(readAdapterSettings(from({ POLICY_WORKER_URL: '', DNA_API_KEY: KEY })).endpoint).toBeUndefined();
  });

  it('should still read POLICY_SHARED_SECRET as the key', () => {
    expect(
      readAdapterSettings(from({ POLICY_WORKER_URL: CUSTOM, POLICY_SHARED_SECRET: OLD_KEY })).apiKey
    ).toBe(OLD_KEY);
  });

  it('should prefer each DNA_ name over the name it replaces', () => {
    const s = readAdapterSettings(
      from({
        DNA_API_KEY: KEY,
        POLICY_ADAPTER_KEY: OLD_KEY,
        DNA_ENDPOINT: CUSTOM,
        POLICY_WORKER_URL: 'https://old.example/v1/decision',
        DNA_TIMEOUT_MS: '300',
        POLICY_TIMEOUT_MS: '700',
        DNA_PAYMENT_TIMEOUT_MS: '4000',
        POLICY_PAYMENT_TIMEOUT_MS: '9000',
        DNA_FAIL_MODE: 'open',
        FAIL_MODE: 'closed',
        DNA_DEBUG_LOG_RAW_PAYLOAD: 'false',
        DEBUG_LOG_RAW_PAYLOAD: 'true',
      })
    );
    expect(s).toEqual({
      endpoint: CUSTOM,
      apiKey: KEY,
      timeoutMs: 300,
      paymentTimeoutMs: 4000,
      failMode: 'open',
      debugLogRawPayload: false,
      exclude: { headers: [], cookies: [] },
    });
  });

  it('should read the exclusions as names: headers lowercase, cookies as sent, blanks and repeats dropped', () => {
    const s = readAdapterSettings(
      from({
        DNA_EXCLUDE_HEADERS: ' X-Api-Key, ,x-api-key,X-Partner ',
        DNA_EXCLUDE_COOKIES: 'SessionId, cart,SessionId',
      })
    );
    expect(s.exclude).toEqual({ headers: ['x-api-key', 'x-partner'], cookies: ['SessionId', 'cart'] });
    expect(readAdapterSettings(from({ DNA_EXCLUDE_HEADERS: '' })).exclude).toEqual({
      headers: [],
      cookies: [],
    });
  });

  it('should switch on a half-migrated install: DNA_API_KEY beside the legacy URL', () => {
    const s = readAdapterSettings(from({ DNA_API_KEY: KEY, POLICY_WORKER_URL: CUSTOM }));
    expect(s.endpoint).toBe(CUSTOM);
  });

  it('should switch on a half-migrated install: DNA_ENDPOINT beside the legacy key', () => {
    const s = readAdapterSettings(from({ DNA_ENDPOINT: CUSTOM, POLICY_ADAPTER_KEY: OLD_KEY }));
    expect(s).toMatchObject({ endpoint: CUSTOM, apiKey: OLD_KEY });
  });

  it('should fall back to the default budgets and fail open on missing or unusable values', () => {
    const s = readAdapterSettings(
      from({ DNA_TIMEOUT_MS: 'soon', DNA_PAYMENT_TIMEOUT_MS: '0', DNA_FAIL_MODE: 'shut' })
    );
    expect(s).toMatchObject({
      timeoutMs: DEFAULT_POLICY_TIMEOUT_MS,
      paymentTimeoutMs: DEFAULT_PAYMENT_TIMEOUT_MS,
      failMode: 'open',
      debugLogRawPayload: false,
    });
  });

  it('should let an earlier source win per setting, whatever name the later one uses', () => {
    const config = from({ DNA_FAIL_MODE: 'closed', DNA_API_KEY: KEY });
    const env = from({ FAIL_MODE: 'open', POLICY_WORKER_URL: CUSTOM, DNA_TIMEOUT_MS: '300' });
    const s = readAdapterSettings(config, env);
    expect(s).toMatchObject({ apiKey: KEY, failMode: 'closed', timeoutMs: 300, endpoint: CUSTOM });
  });

  it('should switch on by the name the sent key came from, not by a DNA_API_KEY elsewhere', () => {
    const config = from({ POLICY_ADAPTER_KEY: OLD_KEY });
    const env = from({ DNA_API_KEY: KEY });
    const s = readAdapterSettings(config, env);
    expect(s).toMatchObject({ apiKey: OLD_KEY, endpoint: undefined });
  });
});

describe('readAdapterSettings: empty values', () => {
  it('should not let an empty DNA_ name hide the setting it replaces', () => {
    const s = readAdapterSettings(
      from({
        POLICY_WORKER_URL: CUSTOM,
        DNA_API_KEY: '',
        POLICY_ADAPTER_KEY: OLD_KEY,
        DNA_FAIL_MODE: '',
        FAIL_MODE: 'closed',
        DNA_TIMEOUT_MS: '',
        POLICY_TIMEOUT_MS: '700',
      })
    );
    expect(s).toMatchObject({ endpoint: CUSTOM, apiKey: OLD_KEY, failMode: 'closed', timeoutMs: 700 });
  });

  it('should stay off on an empty DNA_API_KEY alone', () => {
    expect(readAdapterSettings(from({ DNA_API_KEY: '' })).endpoint).toBeUndefined();
  });

  it('should treat an empty DNA_ENABLED as unset', () => {
    expect(readAdapterSettings(from({ DNA_API_KEY: KEY, DNA_ENABLED: '' })).endpoint).toBe(
      DEFAULT_DNA_ENDPOINT
    );
  });
});

describe('readAdapterSettings: generic legacy names', () => {
  it('should ignore a host app DEBUG_LOG_RAW_PAYLOAD on a DNA_API_KEY install', () => {
    const s = readAdapterSettings(from({ DNA_API_KEY: KEY, DEBUG_LOG_RAW_PAYLOAD: 'true' }));
    expect(s.debugLogRawPayload).toBe(false);
  });

  it('should still read DEBUG_LOG_RAW_PAYLOAD on an install configured with POLICY_WORKER_URL', () => {
    const s = readAdapterSettings(from({ POLICY_WORKER_URL: CUSTOM, DEBUG_LOG_RAW_PAYLOAD: 'true' }));
    expect(s.debugLogRawPayload).toBe(true);
  });

  it('should read FAIL_MODE everywhere, so a half-finished migration never loosens fail-closed', () => {
    expect(readAdapterSettings(from({ DNA_API_KEY: KEY, FAIL_MODE: 'closed' })).failMode).toBe('closed');
    expect(readAdapterSettings(from({ DNA_ENDPOINT: CUSTOM, FAIL_MODE: 'closed' })).failMode).toBe('closed');
  });
});
