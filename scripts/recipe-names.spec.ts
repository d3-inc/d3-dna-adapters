import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { callsEndpoint, parseAdapterName } from '../packages/protocol/src/adapter/adapter-name.ts';
import { RECIPES, recipeLiterals, recipeVersionProblems, type RecipeChange } from './recipe-names.ts';

const source = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

describe('each recipe names itself', () => {
  it.each(RECIPES.map((recipe) => [recipe.literalFile, recipe] as const))(
    '%s sends one well-formed name of its type, on the endpoint it calls',
    (_file, recipe) => {
      const literals = recipeLiterals(source(recipe.literalFile), recipe);
      expect(literals).toHaveLength(1);

      const name = parseAdapterName(literals[0]);
      expect(name?.type).toBe(recipe.type);
      expect(callsEndpoint(recipe.type, recipe.endpoint)).toBe(true);
    }
  );

  it('lists only files that exist', () => {
    for (const recipe of RECIPES) {
      for (const file of recipe.files) expect(existsSync(new URL(`../${file}`, import.meta.url))).toBe(true);
    }
  });
});

describe('recipeVersionProblems', () => {
  const caddy = RECIPES.find((r) => r.type === 'caddy')!;
  const named = (version: string) => `header_up dna-adapter caddy:${version}\n`;
  const change = (before: string | null, after: string, changed = true): RecipeChange => ({
    recipe: caddy,
    changed,
    before: before === null ? null : named(before),
    after: named(after),
  });

  it('passes a change that raises the version', () => {
    expect(recipeVersionProblems([change('1.0.0', '1.0.1'), change('1.0.0', '2.0.0')])).toEqual([]);
  });

  it('passes an unchanged recipe, and one the base did not name', () => {
    expect(recipeVersionProblems([change('1.0.0', '1.0.0', false), change(null, '1.0.0')])).toEqual([]);
  });

  it.each([
    ['keeps it', '1.0.0'],
    ['only adds build metadata, which orders the same', '1.0.0+fix'],
    ['lowers it to a pre-release', '1.0.0-fix'],
    ['lowers it', '0.9.0'],
  ])('refuses a change that %s', (_name, after) => {
    expect(recipeVersionProblems([change('1.0.0', after)])).toEqual([
      `caddy/dna.caddy: changed, but names caddy:${after} (was caddy:1.0.0); raise its version`,
    ]);
  });

  it('refuses a recipe that names no single build', () => {
    expect(
      recipeVersionProblems([{ recipe: caddy, changed: true, before: named('1.0.0'), after: 'no literal' }])
    ).toEqual(['caddy/dna.caddy: 0 dna-adapter literals, not one']);
  });
});
