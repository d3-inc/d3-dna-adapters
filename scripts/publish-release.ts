// publish.yml's publish job. It holds the id-token, so it installs nothing and runs only node, git and npm.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { versionIntegrity } from './registry.ts';
import { assertTarballs, planRelease, readJson, tarballName, type ReleasePlan } from './release-plan.ts';
import { publishDecision, RELEASE_PACKAGES, sha512Integrity } from './release.ts';

const DIR = 'release';

// Trusted publishing needs npm 11.5.1 or later.
const [major, minor, patch] = execFileSync('npm', ['--version'], { encoding: 'utf8' })
  .trim()
  .split('.')
  .map(Number);
if (major < 11 || (major === 11 && (minor < 5 || (minor === 5 && patch < 1)))) {
  throw new Error(`npm ${major}.${minor}.${patch} cannot use trusted publishing; it needs 11.5.1 or later`);
}

const approved = readJson<ReleasePlan & { packages: { name: string; file: string; integrity: string }[] }>(
  join(DIR, 'release.json')
);
const plan = await planRelease();
for (const key of ['tag', 'version', 'distTag', 'commit'] as const) {
  if (plan[key] !== approved[key]) {
    throw new Error(`the pack job planned ${key} ${approved[key]}, not ${plan[key]}`);
  }
}

assertTarballs(DIR, plan.version);

// Every tarball is checked before any publishes, so a bad one cannot leave the release half on npm.
const steps = [];
for (const p of RELEASE_PACKAGES) {
  const entry = approved.packages.find((a) => a.name === p.name);
  if (!entry) throw new Error(`the pack job packed no ${p.name}`);
  // The file assertTarballs checked, not one release.json names.
  const file = tarballName(p.name, plan.version);
  if (entry.file !== file) throw new Error(`release.json names ${entry.file} for ${p.name}, not ${file}`);
  // Absolute: npm reads a bare `dir/file.tgz` as a GitHub `user/repo` spec.
  const path = resolve(DIR, file);
  const local = sha512Integrity(readFileSync(path));
  if (local !== entry.integrity) throw new Error(`${entry.file} is not the tarball the pack job summarised`);

  const label = `${p.name}@${plan.version}`;
  steps.push({
    label,
    path,
    decision: publishDecision(local, await versionIntegrity(p.name, plan.version), label),
  });
}

for (const { label, path, decision } of steps) {
  if (decision === 'skip') {
    console.log(`${label} is already on npm with these contents; skipped`);
    continue;
  }

  execFileSync('npm', ['publish', path, '--tag', plan.distTag, '--access', 'public', '--provenance'], {
    stdio: 'inherit',
  });
}
