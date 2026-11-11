import { adapterNameOf } from '@d3-inc/d3-dna-protocol';

// Defined by tsup at pack time; a source build that defines nothing names no build.
declare const __DNA_ADAPTER_VERSION__: string | undefined;

const PACKED_VERSION = typeof __DNA_ADAPTER_VERSION__ === 'string' ? __DNA_ADAPTER_VERSION__ : undefined;

export const MIDDLEWARE_ADAPTER_NAME = adapterNameOf('vercel-middleware', PACKED_VERSION);

export const MCP_ROUTE_ADAPTER_NAME = adapterNameOf('vercel-mcp', PACKED_VERSION);
