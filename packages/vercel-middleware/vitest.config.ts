import { defineConfig } from 'vitest/config';

// Plain Node pool: the middleware uses only Web-standard APIs, with deps injected in tests.
export default defineConfig({
  define: { __DNA_ADAPTER_VERSION__: JSON.stringify('0.0.0-test') },
  test: {
    include: ['src/**/*.spec.ts'],
    setupFiles: ['./src/vitest.setup.ts'],
  },
});
