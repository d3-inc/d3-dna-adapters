import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { latestVersion } from './registry.ts';
import {
  bakedNameProblem,
  compareReleases,
  distTagFor,
  packedManifestProblems,
  parseReleaseTag,
  RELEASE_PACKAGES,
  type PackedManifest,
  type TaggedCommit,
} from './release.ts';

export const git = (...args: string[]) =>
  execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();

export interface ReleasePlan {
  tag: string;
  version: string;
  distTag: string;
  commit: string;
}

/**
 * Which reviewed lines hold a commit: `main` and each `release/X.Y`. Only a branch's first-parent
 * line counts, the commits a merged PR lands as. A commit merged in from a side branch, or merged and
 * reverted in one PR, is reachable from `main` but was never its reviewed state. Needs every branch
 * fetched (`fetch-depth: 0`).
 */
export function reviewedLinesHolding(commit: string): TaggedCommit {
  const holds = (branch: string) => git('rev-list', '--first-parent', branch).split('\n').includes(commit);
  const releaseBranches = git('for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin/release/')
    .split('\n')
    .filter((b) => /^origin\/release\/\d+\.\d+$/.test(b));
  return {
    onMain: holds('origin/main'),
    releaseLines: releaseBranches.filter(holds).map((b) => b.slice('origin/release/'.length)),
  };
}

/**
 * What the tag in GITHUB_REF_NAME releases, and under which dist-tag. Both publish.yml jobs compute
 * it, so the publish job does not take the pack job's word for it.
 */
export async function planRelease(): Promise<ReleasePlan> {
  const tagName = process.env.GITHUB_REF_NAME ?? '';
  const tag = parseReleaseTag(tagName);
  const commit = git('rev-parse', 'HEAD');
  const latest = (await Promise.all(RELEASE_PACKAGES.map((p) => latestVersion(p.name))))
    .filter((v): v is string => v !== null)
    .sort(compareReleases)
    .at(-1);
  const distTag = distTagFor(tag, reviewedLinesHolding(commit), latest ?? null);
  return { tag: tagName, version: tag.version, distTag, commit };
}

/** `pnpm pack`'s file name for a package version. */
export const tarballName = (name: string, version: string) =>
  `${name.replace('@', '').replace('/', '-')}-${version}.tgz`;

const tar = (...args: string[]) =>
  execFileSync('tar', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

/** A tarball's manifest and its paths with the `package/` prefix removed. */
export function readTarball(path: string): { manifest: PackedManifest; files: string[] } {
  const files = tar('-tzf', path)
    .split('\n')
    .filter(Boolean)
    .map((f) => f.replace(/^package\//, ''));
  return { manifest: JSON.parse(tar('-xOzf', path, 'package/package.json')) as PackedManifest, files };
}

/** Throws with every problem the release's tarballs in `dir` have. */
export function assertTarballs(dir: string, version: string): void {
  const problems = RELEASE_PACKAGES.flatMap((p) => {
    const path = join(dir, tarballName(p.name, version));
    const { manifest, files } = readTarball(path);
    const named = p.namesItself
      ? bakedNameProblem(p.name, version, tar('-xOzf', path, 'package/dist/index.js'))
      : null;
    return [...packedManifestProblems(manifest, { name: p.name, version }, files), ...(named ? [named] : [])];
  });
  if (problems.length) throw new Error(`the tarballs cannot publish:\n- ${problems.join('\n- ')}`);
}

export const readJson = <T>(path: string) => JSON.parse(readFileSync(path, 'utf8')) as T;
