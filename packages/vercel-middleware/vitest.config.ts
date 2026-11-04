import { defineConfig } from 'vitest/config';

// Plain Node pool: the middleware uses only Web-standard APIs, with deps injected in tests.
export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts'],
    setupFiles: ['./src/vitest.setup.ts'],
  },
});
