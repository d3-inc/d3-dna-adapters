import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { callsEndpoint, parseAdapterName } from '../packages/protocol/src/adapter/adapter-name.ts';
import { RECIPES, recipeLiterals, recipeVersionProblems } from './recipe-names.ts';

const source = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

describe('each recipe names itself', () => {
  it.each(RECIPES.map((recipe) => [recipe.file, recipe] as const))(
    '%s sends one well-formed name of its type, on the endpoint it calls',
    (_file, recipe) => {
      const literals = recipeLiterals(source(recipe.file), recipe);
      expect(literals).toHaveLength(1);

      const name = parseAdapterName(literals[0]);
      expect(name?.type).toBe(recipe.type);
      expect(callsEndpoint(recipe.type, recipe.endpoint)).toBe(true);
    }
  );
});

describe('recipeVersionProblems', () => {
  const caddy = (version: string, body = '') => `header_up dna-adapter caddy:${version}\n${body}`;

  it('passes a change that bumps the version, and one to the version alone', () => {
    expect(
      recipeVersionProblems([
        { file: 'caddy/dna.caddy', before: caddy('1.0.0'), after: caddy('1.0.1', 'new') },
        { file: 'caddy/dna.caddy', before: caddy('1.0.0'), after: caddy('1.1.0') },
      ])
    ).toEqual([]);
  });

  it('passes an unchanged recipe and one the base did not have', () => {
    expect(
      recipeVersionProblems([
        { file: 'caddy/dna.caddy', before: caddy('1.0.0'), after: caddy('1.0.0') },
        { file: 'caddy/dna.caddy', before: null, after: caddy('1.0.0') },
      ])
    ).toEqual([]);
  });

  it('refuses a change that keeps the version, or leaves no single literal', () => {
    expect(
      recipeVersionProblems([
        { file: 'caddy/dna.caddy', before: caddy('1.0.0'), after: caddy('1.0.0', 'new') },
        { file: 'caddy/dna.caddy', before: caddy('1.0.0'), after: 'no literal at all' },
      ])
    ).toEqual([
      'caddy/dna.caddy: changed, but still names caddy:1.0.0; bump its version',
      'caddy/dna.caddy: 0 dna-adapter literals, not one',
    ]);
  });
});
