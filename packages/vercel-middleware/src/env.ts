import {
  readAdapterSettings,
  type AdapterSettingName,
  type AdapterSettings,
  type SettingLookup,
} from '@d3-inc/d3-dna-protocol';

/** Options for the D3 middleware; anything omitted falls back to env vars. */
export interface D3MiddlewareConfig {
  /** The org's API key. Set ⇒ DNA is on, calling the default endpoint. */
  apiKey?: string;
  /** Decision endpoint override; empty ⇒ off. */
  endpoint?: string;
  /** `false` turns DNA off without removing the key. */
  enabled?: boolean;
  /** Hot-path budget for the policy call, ms (default 10000). */
  timeoutMs?: number;
  /** Budget for a request presenting a payment, ms (default 10000). Sized in
   *  seconds, not the hot path's milliseconds: settlement happens inside it. */
  paymentTimeoutMs?: number;
  /** "open" (default): pass traffic when the policy call fails; "closed": block. */
  failMode?: 'open' | 'closed';
  /** Forward every request header but the credentials, for the worker's request
   *  record (kept only under its own DEBUG_LOG_RAW_PAYLOAD). Off in production. */
  debugLogRawPayload?: boolean;
  /** Request headers kept back from DNA; every other header is forwarded (ADR 0081). */
  excludeHeaders?: string | string[];
  /** Cookies kept back from DNA by name; every other cookie is forwarded. */
  excludeCookies?: string | string[];
  /** @deprecated `endpoint`. Unlike `apiKey`, the old key names need this set to switch DNA on. */
  policyWorkerUrl?: string;
  /** @deprecated `apiKey` */
  adapterKey?: string;
  /** @deprecated `apiKey` */
  sharedSecret?: string;
}

function envVar(key: AdapterSettingName): string | undefined {
  return typeof process !== 'undefined' ? process.env?.[key] : undefined;
}

// Each option under the env name it stands in for, so the config and the env
// resolve through one rule.
function configLookup(config: D3MiddlewareConfig): SettingLookup {
  const byName: Partial<Record<AdapterSettingName, string>> = {
    DNA_API_KEY: config.apiKey,
    POLICY_ADAPTER_KEY: config.adapterKey,
    POLICY_SHARED_SECRET: config.sharedSecret,
    DNA_ENDPOINT: config.endpoint,
    POLICY_WORKER_URL: config.policyWorkerUrl,
    DNA_ENABLED: config.enabled?.toString(),
    DNA_FAIL_MODE: config.failMode,
    DNA_TIMEOUT_MS: config.timeoutMs?.toString(),
    DNA_PAYMENT_TIMEOUT_MS: config.paymentTimeoutMs?.toString(),
    DNA_DEBUG_LOG_RAW_PAYLOAD: config.debugLogRawPayload?.toString(),
    DNA_EXCLUDE_HEADERS: listSetting(config.excludeHeaders),
    DNA_EXCLUDE_COOKIES: listSetting(config.excludeCookies),
  };
  return (name) => byName[name];
}

function listSetting(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(',') : value;
}

export function resolveConfig(config: D3MiddlewareConfig = {}): AdapterSettings {
  return readAdapterSettings(configLookup(config), envVar);
}
