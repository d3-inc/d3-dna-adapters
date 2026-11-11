// CI: `node scripts/check-proven-mechanisms.ts [base ref]`. Fails `proven-mechanisms.json`
// where it claims more than the code's tests prove; with a base, also where it re-scopes a build the base holds.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { provenMechanismProblems, type ProvenMechanisms } from './proven-mechanisms.ts';

const RECORD = 'proven-mechanisms.json';
const base = process.argv[2];

const git = (...args: string[]) =>
  execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

function atBase(): ProvenMechanisms {
  if (!base) return {};

  // A missing base would read every build as new, and pass.
  try {
    git('rev-parse', '--verify', '--quiet', `${base}^{commit}`);
  } catch {
    console.error(`✗ base ${base} is not a commit here: fetch it first`);
    process.exit(2);
  }

  try {
    return JSON.parse(git('show', `${base}:${RECORD}`)) as ProvenMechanisms;
  } catch {
    return {};
  }
}

const record = JSON.parse(readFileSync(RECORD, 'utf8')) as ProvenMechanisms;
const problems = provenMechanismProblems(record, atBase(), (file) =>
  existsSync(file) ? readFileSync(file, 'utf8') : null
);
for (const problem of problems) console.error(`✗ ${problem}`);

if (problems.length > 0) process.exit(1);

console.log(
  `✓ every mechanism in ${RECORD} cites a test that runs${base ? `, and no build ${base} holds changed` : ''}`
);
