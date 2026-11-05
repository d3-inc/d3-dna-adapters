import { configureEdgeLogging } from '@d3-inc/d3-dna-protocol';

// Vercel entrypoint: configure at module load so the middleware's fail-open/closed paths aren't silent in production.
configureEdgeLogging();

export { configureEdgeLogging };
export { createD3Middleware } from './middleware';
export type { MiddlewareDeps } from './middleware';
export type { D3MiddlewareConfig } from './env';

/**
 * Ready-made Vercel Routing Middleware `config`. Runs on the Edge runtime and
 * skips static assets (tune the matcher to your framework's asset paths). The
 * site can re-export this or provide its own.
 *
 *   // middleware.ts (site root)
 *   import { createD3Middleware, config } from '@d3-inc/d3-dna-vercel-middleware';
 *   export default createD3Middleware();
 *   export { config };
 */
export const config = {
  matcher: '/((?!_next/static|_next/image|favicon.ico).*)',
  runtime: 'edge',
} as const;
