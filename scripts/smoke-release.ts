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

const all = RELEASE_PACKAGES.map((p) => p.name);
const imports = `
  for (const name of process.argv.slice(1)) {
    if (!Object.keys(await import(name)).length) throw new Error(name + ' exports nothing');
  }
`;
run('node', ['--input-type=module', '-e', imports, ...all], project);

const dual = RELEASE_PACKAGES.filter((p) => p.commonjs).map((p) => p.name);
const requires = `
  for (const name of process.argv.slice(1)) require(name);
  const { createD3Middleware } = require('@d3-inc/d3-dna-vercel-middleware');
  if (typeof createD3Middleware() !== 'function') throw new Error('Expected a middleware function');
`;
// Node 24 can load ESM through require(), which would hide a missing CommonJS build.
run('node', ['--no-experimental-require-module', '--input-type=commonjs', '-e', requires, ...dual], project);
console.log(
  `Installed and imported ${all.join(', ')}, and required ${dual.join(', ')}, at ${approved.version}`
);
