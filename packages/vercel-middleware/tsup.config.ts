import { defineConfig } from 'tsup';

// @d3-inc/d3-dna-protocol and @vercel/functions stay external — real deps resolved by the consumer.
export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
});
