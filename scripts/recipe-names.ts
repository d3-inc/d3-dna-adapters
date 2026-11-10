// Node-run (`check-recipe-versions.ts`), so it imports nothing from the packages,
// whose sources Node cannot resolve.

/** Each recipe that names itself in `dna-adapter`, where the literal sits, and what it must name. */
export const RECIPES = [
  {
    file: 'cloudflare-snippet/snippet.js',
    type: 'snippet',
    endpoint: 'decision',
    literal: /const DNA_ADAPTER = '([^']+)';/g,
  },
  {
    file: 'openresty/dna.lua',
    type: 'openresty',
    endpoint: 'decision',
    literal: /local DNA_ADAPTER = "([^"]+)"/g,
  },
  {
    file: 'caddy/dna.caddy',
    type: 'caddy',
    endpoint: 'forward-auth',
    literal: /header_up dna-adapter (\S+)/g,
  },
  {
    file: 'nginx-auth-request/d3-edge.conf',
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

/** One recipe as it stands on the base and on the change. `before` is null for a recipe the base lacks. */
export interface RecipeChange {
  file: string;
  before: string | null;
  after: string;
}

/**
 * A recipe whose file changed but whose `dna-adapter` literal did not: the worker
 * would read the new build by the old one's row. Changing only the literal is fine.
 */
export function recipeVersionProblems(changes: readonly RecipeChange[]): string[] {
  const problems: string[] = [];
  for (const change of changes) {
    if (change.before === null || change.before === change.after) continue;

    const recipe = RECIPES.find((r) => r.file === change.file);
    if (recipe === undefined) continue;

    const before = recipeLiterals(change.before, recipe);
    const after = recipeLiterals(change.after, recipe);
    if (after.length !== 1) problems.push(`${change.file}: ${after.length} dna-adapter literals, not one`);
    else if (before.length === 1 && before[0] === after[0]) {
      problems.push(`${change.file}: changed, but still names ${after[0]}; bump its version`);
    }
  }

  return problems;
}
