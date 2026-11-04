import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts'],
    setupFiles: ['./src/vitest.setup.ts'],
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
      miniflare: {
        // ORIGIN binding is absent in the test runtime; stub it so workerd boots.
        serviceBindings: {
          ORIGIN: async () => new Response('stub origin'),
        },
      },
    }),
  ],
});
