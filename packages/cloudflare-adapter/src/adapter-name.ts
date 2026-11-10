import { adapterNameOf } from '@d3-inc/d3-dna-protocol';

// Defined by tsup at pack time; a source build that defines nothing names no build.
declare const __DNA_ADAPTER_VERSION__: string | undefined;

export const ADAPTER_NAME = adapterNameOf(
  'cloudflare',
  typeof __DNA_ADAPTER_VERSION__ === 'string' ? __DNA_ADAPTER_VERSION__ : undefined
);
