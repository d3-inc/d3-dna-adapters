import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MAX_PACKAGE_BYTES, bundleProblem, sizeProblem } from './snippet-bundle.ts';

const OK = { code: 'var x = 1;\ncreateSnippet(CONFIG);\n', inputs: ['cloudflare-snippet/src/snippet.ts'] };

describe('bundleProblem', () => {
  it('passes a bundle that reads CONFIG and installs nothing', () => {
    expect(bundleProblem(OK)).toBeUndefined();
  });

  it('refuses a bundle that reached a package', () => {
    // The paste installs nothing, so a dependency is a file the Snippet lacks.
    const inputs = [...OK.inputs, 'node_modules/.pnpm/@logtape+logtape@2.4.2/dist/logger.js'];
    expect(bundleProblem({ ...OK, inputs })).toMatch(/reached a package.*logtape/);
  });

  it.each([
    ['var', 'var CONFIG = {};'],
    ['let', 'let CONFIG = {};'],
    ['const', 'const CONFIG = {};'],
    ['function', 'function CONFIG() {}'],
    ['class', 'class CONFIG {}'],
  ])('refuses a bundle declaring CONFIG as a %s', (_kind, declaration) => {
    // It would shadow the pasted block, and the paste would run on this instead.
    expect(bundleProblem({ ...OK, code: `${declaration}\n${OK.code}` })).toMatch(/shadow the pasted block/);
  });

  it('refuses a bundle that never reads CONFIG', () => {
    expect(bundleProblem({ ...OK, code: 'var x = 1;\n' })).toMatch(/never reads CONFIG/);
  });
});

describe('sizeProblem', () => {
  it('passes a file inside the Snippet budget', () => {
    expect(sizeProblem('x'.repeat(MAX_PACKAGE_BYTES))).toBeUndefined();
  });

  it('refuses a file past it, by bytes rather than characters', () => {
    expect(sizeProblem('x'.repeat(MAX_PACKAGE_BYTES + 1))).toMatch(/over budget/);
    // One multi-byte character is three bytes: a length check would pass this.
    expect(sizeProblem('→'.repeat(MAX_PACKAGE_BYTES / 2))).toMatch(/over budget/);
  });

  it('passes the file this repo ships', () => {
    // The artifact, not a bundle body: it carries the prepended CONFIG block,
    // which is the one declaration bundleProblem exists to refuse.
    const paste = readFileSync(new URL('../cloudflare-snippet/snippet.js', import.meta.url), 'utf8');
    expect(sizeProblem(paste)).toBeUndefined();
  });
});
