// What the generated Snippet must be true of, apart from its content. Each of
// these is a way the build passes every other check and the paste still fails,
// so each is a refusal rather than a warning.

/**
 * Cloudflare rejects a Snippet over this, so a build that passes CI and fails
 * the paste is the failure this budget exists to catch
 * (https://developers.cloudflare.com/rules/snippets/#limits).
 */
export const MAX_PACKAGE_BYTES = 32 * 1024;

const DECLARES_CONFIG = /\b(?:var|let|const|function|class)\s+CONFIG\b/;

export interface SnippetBundle {
  /** The bundle body, before the header and the CONFIG block are prepended. */
  code: string;
  /** Every file esbuild read, as its metafile names them. */
  inputs: readonly string[];
}

/** Why this bundle must not be written, or undefined when it may be. */
export function bundleProblem({ code, inputs }: SnippetBundle): string | undefined {
  // A Snippet installs nothing, so anything reached through node_modules is a
  // dependency the paste would be missing. The protocol's barrel is the way in:
  // it re-exports the logger, and logtape alone is 48 KB of a 32 KB budget.
  const dependency = inputs.find((input) => input.includes('node_modules'));
  if (dependency !== undefined) {
    return `the bundle reached a package: ${dependency}. Import the module, not the barrel`;
  }

  // The CONFIG block is prepended rather than bundled, so the customer edits the
  // top of the file and the bundle reads `CONFIG` as a free variable. A module
  // declaring its own would shadow the block, and the paste would silently run
  // on esbuild's binding instead of the customer's settings.
  if (DECLARES_CONFIG.test(code)) {
    return 'the bundle declares its own CONFIG, which would shadow the pasted block';
  }

  if (!/\bCONFIG\b/.test(code)) {
    return 'the bundle never reads CONFIG, so the pasted settings would do nothing';
  }

  return undefined;
}

/** Why this finished file must not be written, or undefined when it may be. */
export function sizeProblem(source: string): string | undefined {
  const bytes = Buffer.byteLength(source, 'utf8');
  return bytes > MAX_PACKAGE_BYTES ? `over budget: ${sizeReport(source)}` : undefined;
}

export function sizeReport(source: string): string {
  const bytes = Buffer.byteLength(source, 'utf8');
  const percent = ((bytes / MAX_PACKAGE_BYTES) * 100).toFixed(1);
  return `${bytes} bytes, ${percent}% of Cloudflare's ${MAX_PACKAGE_BYTES}-byte Snippet budget`;
}
