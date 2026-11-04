import { defineConfig } from 'tsup';

// @d3-inc/d3-dna-protocol stays external — a real dep resolved by the consumer's
// own bundler (wrangler), same as the vercel-middleware build.
export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
});
