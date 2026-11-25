import { afterEach, beforeEach, vi } from 'vitest';

// The middleware reads process.env, so a DNA_* or POLICY_* variable in the
// shell running the tests would otherwise decide them.
const ADAPTER_ENV = /^(DNA_|POLICY_)|^(FAIL_MODE|DEBUG_LOG_RAW_PAYLOAD)$/;

beforeEach(() => {
  for (const name of Object.keys(process.env)) {
    if (ADAPTER_ENV.test(name)) vi.stubEnv(name, undefined);
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
});
