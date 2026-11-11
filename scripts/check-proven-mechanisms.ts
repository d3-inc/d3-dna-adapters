// CI: `node scripts/check-proven-mechanisms.ts [base ref]`. Fails `proven-mechanisms.json`
// where it claims more than the code's tests prove; with a base, also where it re-scopes a
// build the base holds, or adds one for a version already out.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import {
  compareAdapterVersions,
  isAdapterVersion,
  parseAdapterName,
} from '../packages/protocol/src/adapter/adapter-name.ts';
import { provenMechanismProblems, type ProvenMechanisms } from './proven-mechanisms.ts';
import { RECIPES, recipeLiterals } from './recipe-names.ts';

const RECORD = 'proven-mechanisms.json';
const base = process.argv[2];

const git = (...args: string[]) =>
  execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

const stop = (why: string): never => {
  console.error(`✗ ${why}`);
  process.exit(2);
};

function atBase(): ProvenMechanisms | null {
  if (!base) return null;

  // A missing base would read every build as new, and pass.
  try {
    git('rev-parse', '--verify', '--quiet', `${base}^{commit}`);
  } catch {
    stop(`base ${base} is not a commit here: fetch it first`);
  }

  let text: string;
  try {
    text = git('show', `${base}:${RECORD}`);
  } catch {
    return {};
  }

  try {
    return JSON.parse(text) as ProvenMechanisms;
  } catch {
    return stop(`${RECORD} on ${base} does not parse, so nothing can be compared with it`);
  }
}

function newestRelease(): string | null {
  const versions = git('tag', '--list', 'v*')
    .split('\n')
    .map((tag) => tag.trim().slice(1))
    .filter(isAdapterVersion);
  return versions.sort(compareAdapterVersions).at(-1) ?? null;
}

function recipeVersions(): Record<string, string> {
  const versions: Record<string, string> = {};
  for (const recipe of RECIPES) {
    const literals = recipeLiterals(readFileSync(recipe.literalFile, 'utf8'), recipe);
    const name = literals.length === 1 ? parseAdapterName(literals[0]) : null;
    if (name !== null) versions[recipe.type] = name.version;
  }

  return versions;
}

const record = JSON.parse(readFileSync(RECORD, 'utf8')) as ProvenMechanisms;
const previous = atBase();
const released = newestRelease();
if (previous !== null && released === null)
  {stop('no v* tag here, so a new build cannot be dated: fetch tags');}

const problems = provenMechanismProblems(record, {
  base: previous,
  source: (file) => (existsSync(file) ? readFileSync(file, 'utf8') : null),
  newestRelease: released,
  recipeVersions: recipeVersions(),
});
for (const problem of problems) console.error(`✗ ${problem}`);

if (problems.length > 0) process.exit(1);

console.log(
  `✓ every mechanism in ${RECORD} cites a running test of its own build${base ? `, against ${base}` : ''}`
);
