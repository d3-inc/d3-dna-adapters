import { defineConfig } from 'tsup';

// pack-release sets it from the release tag, so a published build names itself
// by that tag (ADR 0092 decision 1); any other build names no build.
const packed = process.env.DNA_PACKED_VERSION;

// @d3-inc/d3-dna-protocol and @vercel/functions stay external — real deps resolved by the consumer.
export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  define: packed ? { __DNA_ADAPTER_VERSION__: JSON.stringify(packed) } : {},
});
