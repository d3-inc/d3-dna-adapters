import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));

// `import type` is left out: Node strips it, so it never loads at run time.
const VALUE_IMPORT = /^(?:import|export)(?!\s+type\b)\s[^;]*?\sfrom\s+'([^']+)';/gm;
const BARE_IMPORT = /^import\s+'([^']+)';/gm;

/** Every package a script loads, through any chain of relative imports. */
function packagesReachedFrom(entry: string): string[] {
  const seen = new Set<string>();
  const packages = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const [, specifier] of [...source.matchAll(VALUE_IMPORT), ...source.matchAll(BARE_IMPORT)]) {
      if (specifier.startsWith('.')) visit(join(dirname(file), specifier));
      else packages.add(specifier);
    }
  };

  visit(join(SCRIPTS, entry));
  return [...packages];
}

describe('the publish jobs that never run pnpm install', () => {
  it.each(['smoke-release.ts', 'publish-release.ts'])('%s loads only Node built-ins', (entry) => {
    expect(packagesReachedFrom(entry).filter((name) => !name.startsWith('node:'))).toEqual([]);
  });

  it('finds a package reached through a relative import', () => {
    expect(packagesReachedFrom('check-registry.ts')).toContain('sigstore');
  });
});
