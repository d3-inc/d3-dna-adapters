/**
 * Types for the pasted Cloudflare Snippet (snippet.js). The pasted file is
 * generated JavaScript, because customers paste the file itself; this
 * declaration is what `snippet.spec.ts` and `tsc --noEmit` check it against.
 *
 * `SnippetConfig` comes from the source rather than being restated here: two
 * copies of the settings list is how one of them goes stale.
 */
import type { SnippetConfig } from './src/snippet.ts';

export type { SnippetConfig };

export declare function dnaEndpoint(config: SnippetConfig): string | undefined;

export declare function createSnippet(config: SnippetConfig): {
  fetch(request: Request): Promise<Response>;
};

declare const snippet: ReturnType<typeof createSnippet>;
export default snippet;
