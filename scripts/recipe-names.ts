// Node-run (`check-recipe-versions.ts`): `adapter-name.ts` imports nothing, so
// Node loads it from source.
import { compareAdapterVersions, parseAdapterName } from '../packages/protocol/src/adapter/adapter-name.ts';

/**
 * Each recipe that names itself in `dna-adapter`: every file its install is
 * made of, the file and pattern that hold the literal, and what it must name.
 */
export const RECIPES = [
  {
    files: ['cloudflare-snippet/snippet.js'],
    literalFile: 'cloudflare-snippet/snippet.js',
    type: 'snippet',
    endpoint: 'decision',
    literal: /const DNA_ADAPTER = '([^']+)';/g,
  },
  {
    files: [
      'openresty/dna.lua',
      'openresty/dna_access.lua',
      'openresty/dna.main.conf',
      'openresty/dna.server.conf',
    ],
    literalFile: 'openresty/dna.lua',
    type: 'openresty',
    endpoint: 'decision',
    literal: /local DNA_ADAPTER = "([^"]+)"/g,
  },
  {
    files: ['caddy/dna.caddy'],
    literalFile: 'caddy/dna.caddy',
    type: 'caddy',
    endpoint: 'forward-auth',
    literal: /header_up dna-adapter (\S+)/g,
  },
  {
    files: ['nginx-auth-request/d3-edge.conf'],
    literalFile: 'nginx-auth-request/d3-edge.conf',
    type: 'nginx',
    endpoint: 'forward-auth',
    literal: /proxy_set_header dna-adapter "([^"]+)";/g,
  },
] as const;

export type Recipe = (typeof RECIPES)[number];

/** Every `dna-adapter` literal in a recipe's source; exactly one is right. */
export function recipeLiterals(source: string, recipe: Recipe): string[] {
  return [...source.matchAll(recipe.literal)].map((match) => match[1]);
}

/**
 * One recipe on the base and on the change. `changed` is whether any of its
 * files differ; `before` is its literal file on the base, null for a new recipe.
 */
export interface RecipeChange {
  recipe: Recipe;
  changed: boolean;
  before: string | null;
  after: string;
}

/**
 * A recipe that names no single build, or whose files changed without its
 * version going up: the worker would read the new build by an old one's row.
 */
export function recipeVersionProblems(changes: readonly RecipeChange[]): string[] {
  const problems: string[] = [];
  for (const { recipe, changed, before, after } of changes) {
    const now = recipeLiterals(after, recipe);
    if (now.length !== 1) {
      problems.push(`${recipe.literalFile}: ${now.length} dna-adapter literals, not one`);
      continue;
    }

    const was = before === null ? [] : recipeLiterals(before, recipe);
    if (!changed || was.length !== 1) continue;

    const [current, previous] = [parseAdapterName(now[0]), parseAdapterName(was[0])];
    if (
      current === null ||
      previous === null ||
      compareAdapterVersions(current.version, previous.version) <= 0
    ) {
      problems.push(`${recipe.literalFile}: changed, but names ${now[0]} (was ${was[0]}); raise its version`);
    }
  }

  return problems;
}
