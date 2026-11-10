// CI on a pull request: `node scripts/check-recipe-versions.ts <base ref>`. Fails a
// recipe change that leaves its `dna-adapter` version as it was.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { RECIPES, recipeVersionProblems, type RecipeChange } from './recipe-names.ts';

const base = process.argv[2];
if (!base) {
  console.error('usage: node scripts/check-recipe-versions.ts <base ref>');
  process.exit(2);
}

function atBase(file: string): string | null {
  try {
    return execFileSync('git', ['show', `${base}:${file}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

const changes: RecipeChange[] = RECIPES.map(({ file }) => ({
  file,
  before: atBase(file),
  after: readFileSync(file, 'utf8'),
}));
const problems = recipeVersionProblems(changes);
for (const problem of problems) console.error(`✗ ${problem}`);

if (problems.length > 0) process.exit(1);

console.log(`✓ every changed recipe names a new version (against ${base})`);
