// CI on a pull request: `node scripts/check-recipe-versions.ts <base ref>`. Fails a
// recipe whose files changed without its `dna-adapter` version going up.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { RECIPES, recipeVersionProblems, type RecipeChange } from './recipe-names.ts';

const base = process.argv[2];
if (!base) {
  console.error('usage: node scripts/check-recipe-versions.ts <base ref>');
  process.exit(2);
}

const git = (...args: string[]) =>
  execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

// A missing base would read every recipe as new, and pass.
try {
  git('rev-parse', '--verify', '--quiet', `${base}^{commit}`);
} catch {
  console.error(`✗ base ${base} is not a commit here: fetch it first`);
  process.exit(2);
}

function atBase(file: string): string | null {
  try {
    return git('show', `${base}:${file}`);
  } catch {
    return null;
  }
}

function differs(files: readonly string[]): boolean {
  try {
    git('diff', '--quiet', base, '--', ...files);
    return false;
  } catch {
    return true;
  }
}

const changes: RecipeChange[] = RECIPES.map((recipe) => ({
  recipe,
  changed: differs(recipe.files),
  before: atBase(recipe.literalFile),
  after: readFileSync(recipe.literalFile, 'utf8'),
}));
const problems = recipeVersionProblems(changes);
for (const problem of problems) console.error(`✗ ${problem}`);

if (problems.length > 0) process.exit(1);

console.log(`✓ every changed recipe names a higher version (against ${base})`);
