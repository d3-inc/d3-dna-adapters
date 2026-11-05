// publish.yml's smoke job: installs the packed tarballs as a customer would, in a job that holds no
// id-token and uploads nothing, so a dependency it pulls in cannot change what publishes.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readJson, tarballName, type ReleasePlan } from './release-plan.ts';
import { RELEASE_PACKAGES, sha512Integrity } from './release.ts';

const DIR = resolve('release');
const run = (cmd: string, args: string[], cwd: string) => execFileSync(cmd, args, { cwd, stdio: 'inherit' });

const approved = readJson<ReleasePlan & { packages: { name: string; integrity: string }[] }>(
  join(DIR, 'release.json')
);
const tarballs = RELEASE_PACKAGES.map((p) => {
  const path = join(DIR, tarballName(p.name, approved.version));
  const expected = approved.packages.find((a) => a.name === p.name)?.integrity;
  if (sha512Integrity(readFileSync(path)) !== expected) {
    throw new Error(`${path} is not the tarball the pack job hashed`);
  }

  return path;
});

const project = mkdtempSync(join(tmpdir(), 'release-smoke-'));
writeFileSync(join(project, 'package.json'), '{ "private": true, "type": "module" }\n');
run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', ...tarballs], project);
const imports = RELEASE_PACKAGES.map(
  (p) => `if (!Object.keys(await import('${p.name}')).length) throw new Error('${p.name} exports nothing');`
).join('\n');
run('node', ['--input-type=module', '-e', imports], project);
console.log(
  `Installed and imported ${RELEASE_PACKAGES.map((p) => p.name).join(', ')} at ${approved.version}`
);
