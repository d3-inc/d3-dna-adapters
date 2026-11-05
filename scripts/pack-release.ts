// publish.yml's pack job. It holds no id-token, so nothing it installs or runs can publish.
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { assertTarballs, planRelease, readJson, readTarball, tarballName } from './release-plan.ts';
import { RELEASE_PACKAGES, sha512Integrity } from './release.ts';

const OUT = resolve('release');
const run = (cmd: string, args: string[], cwd?: string) => execFileSync(cmd, args, { cwd, stdio: 'inherit' });

const plan = await planRelease();

// The three packages share one version, set from the tag.
for (const p of RELEASE_PACKAGES) {
  const file = join('packages', p.dir, 'package.json');
  const manifest = readJson<{ name: string; version: string }>(file);
  if (manifest.name !== p.name) throw new Error(`${file} names ${manifest.name}, not ${p.name}`);
  writeFileSync(file, `${JSON.stringify({ ...manifest, version: plan.version }, null, 2)}\n`);
}

// `pnpm pack` alone ships no dist/: prepublishOnly runs only on publish.
run('pnpm', ['build']);
mkdirSync(OUT, { recursive: true });
for (const p of RELEASE_PACKAGES) {
  // pnpm, not npm: it rewrites workspace:* to the exact version and applies publishConfig.
  run('pnpm', ['pack', '--pack-destination', OUT], join('packages', p.dir));
}

assertTarballs(OUT, plan.version);

// Hashed before anything outside the lockfile runs: the smoke job installs and imports in its own job.
const tarballs = RELEASE_PACKAGES.map((p) => join(OUT, tarballName(p.name, plan.version)));
const packages = RELEASE_PACKAGES.map((p, i) => {
  const bytes = readFileSync(tarballs[i]);
  return {
    name: p.name,
    file: tarballName(p.name, plan.version),
    integrity: sha512Integrity(bytes),
    size: bytes.length,
  };
});
writeFileSync(join(OUT, 'release.json'), `${JSON.stringify({ ...plan, packages }, null, 2)}\n`);

// What the npm environment's reviewer approves against.
const summary = [
  `### ${plan.tag} publishes ${plan.version} under \`${plan.distTag}\``,
  '',
  // Written by the tagged commit's own code, so the reviewer reads the commit from GitHub instead.
  "Before approving, open the commit in this run's header on GitHub and confirm it is on `main` (or on `release/*` for a `release-*` dist-tag), and that production serves what this version needs. This summary comes from the tagged commit's own code.",
  '',
  '| Package | Size | Integrity |',
  '| --- | --- | --- |',
  ...packages.map((p) => `| \`${p.name}@${plan.version}\` | ${p.size} B | \`${p.integrity}\` |`),
  '',
  ...packages.flatMap((p, i) => [
    `<details><summary>${p.name} files</summary>`,
    '',
    ...readTarball(tarballs[i]).files.map((f) => `- \`${f}\``),
    '',
    '</details>',
  ]),
  '',
].join('\n');
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
console.log(summary);
