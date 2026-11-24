import { DEFAULT_DNA_ENDPOINT } from '@d3-inc/d3-dna-protocol';
import { describe, expect, it, vi } from 'vitest';
import { resolveConfig } from './env';

// The legacy names are pinned because a fallback with no test is a fallback
// that quietly stops working, and an install still on them must not change.
describe('resolveConfig credential', () => {
  it('takes the API key from config', () => {
    expect(resolveConfig({ apiKey: 'k1' }).apiKey).toBe('k1');
  });

  it('honors the deprecated adapterKey and sharedSecret names', () => {
    expect(resolveConfig({ adapterKey: 'k1' }).apiKey).toBe('k1');
    expect(resolveConfig({ sharedSecret: 'legacy' }).apiKey).toBe('legacy');
  });

  it('prefers apiKey, then adapterKey, then sharedSecret', () => {
    expect(resolveConfig({ apiKey: 'k0', adapterKey: 'k1', sharedSecret: 'legacy' }).apiKey).toBe('k0');
    expect(resolveConfig({ adapterKey: 'k1', sharedSecret: 'legacy' }).apiKey).toBe('k1');
  });
});

describe('resolveConfig on switch', () => {
  it('switches on from an API key alone, by config or by env', () => {
    expect(resolveConfig({ apiKey: 'k1' }).endpoint).toBe(DEFAULT_DNA_ENDPOINT);
    vi.stubEnv('DNA_API_KEY', 'k1');
    expect(resolveConfig({}).endpoint).toBe(DEFAULT_DNA_ENDPOINT);
  });

  it('leaves a legacy key with no URL off, as before', () => {
    expect(resolveConfig({ adapterKey: 'k1' }).endpoint).toBeUndefined();
    vi.stubEnv('POLICY_ADAPTER_KEY', 'k1');
    expect(resolveConfig({}).endpoint).toBeUndefined();
  });

  it('turns off on enabled: false or DNA_ENABLED=false, the config winning', () => {
    expect(resolveConfig({ apiKey: 'k1', enabled: false }).endpoint).toBeUndefined();
    vi.stubEnv('DNA_API_KEY', 'k1');
    vi.stubEnv('DNA_ENABLED', 'false');
    expect(resolveConfig({}).endpoint).toBeUndefined();
    expect(resolveConfig({ enabled: true }).endpoint).toBe(DEFAULT_DNA_ENDPOINT);
  });

  it('keeps an empty policyWorkerUrl as the kill switch', () => {
    vi.stubEnv('DNA_API_KEY', 'k1');
    expect(resolveConfig({ policyWorkerUrl: '' }).endpoint).toBeUndefined();
  });

  it('ignores a host app DEBUG_LOG_RAW_PAYLOAD once configured by DNA_API_KEY', () => {
    vi.stubEnv('DNA_API_KEY', 'k1');
    vi.stubEnv('DEBUG_LOG_RAW_PAYLOAD', 'true');
    expect(resolveConfig({}).debugLogRawPayload).toBe(false);
  });
});

describe('resolveConfig debug', () => {
  it('forwards every header only when asked, by config or by env, the config winning', () => {
    expect(resolveConfig({}).debugLogRawPayload).toBe(false);
    expect(resolveConfig({ debugLogRawPayload: true }).debugLogRawPayload).toBe(true);
    vi.stubEnv('DNA_DEBUG_LOG_RAW_PAYLOAD', 'true');
    expect(resolveConfig({}).debugLogRawPayload).toBe(true);
    expect(resolveConfig({ debugLogRawPayload: false }).debugLogRawPayload).toBe(false);
  });
});

describe('resolveConfig budgets', () => {
  it('resolves both, so the request closure only has to choose', () => {
    const cfg = resolveConfig({});
    expect(cfg.timeoutMs).toBe(10_000);
    expect(cfg.paymentTimeoutMs).toBe(10_000);
  });

  it('takes each from config over its default', () => {
    const cfg = resolveConfig({ timeoutMs: 40, paymentTimeoutMs: 9000 });
    expect(cfg.timeoutMs).toBe(40);
    expect(cfg.paymentTimeoutMs).toBe(9000);
  });

  it('falls back on a value that is not a usable budget', () => {
    const cfg = resolveConfig({ timeoutMs: 0, paymentTimeoutMs: Number.NaN });
    expect(cfg.timeoutMs).toBe(10_000);
    expect(cfg.paymentTimeoutMs).toBe(10_000);
  });

  it('never gives the payment budget less than the ordinary one', () => {
    // Settlement happens inside that call; a shorter budget would abort it.
    const cfg = resolveConfig({});
    expect(cfg.paymentTimeoutMs).toBeGreaterThanOrEqual(cfg.timeoutMs);
  });
});
