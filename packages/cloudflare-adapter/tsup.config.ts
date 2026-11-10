import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

// pack-release sets the version from the release tag before it builds, so a
// published build names itself by that tag (ADR 0092 decision 1).
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

// @d3-inc/d3-dna-protocol stays external — a real dep resolved by the consumer's
// own bundler (wrangler), same as the vercel-middleware build.
export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  define: { __DNA_ADAPTER_VERSION__: JSON.stringify(version) },
});
