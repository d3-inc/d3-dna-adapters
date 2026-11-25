import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reviewedLinesHolding } from './release-plan.ts';

describe('reviewedLinesHolding', () => {
  const dir = mkdtempSync(join(tmpdir(), 'release-plan-'));
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args],
      {
        cwd: dir,
        encoding: 'utf8',
      }
    ).trim();
  const commit = (file: string, message: string) => {
    writeFileSync(join(dir, file), message);
    git('add', file);
    git('commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD');
  };

  const shas: Record<string, string> = {};
  const previousGitDir = process.env.GIT_DIR;

  beforeAll(() => {
    git('init', '-q', '-b', 'main');
    shas.base = commit('a.txt', 'base');
    git('checkout', '-q', '-b', 'side');
    shas.unreviewed = commit('b.txt', 'unreviewed export');
    git('revert', '--no-edit', 'HEAD');
    git('checkout', '-q', 'main');
    git('merge', '-q', '--no-ff', '--no-edit', 'side');
    shas.merge = git('rev-parse', 'HEAD');
    git('checkout', '-q', '-b', 'release/0.10', shas.base);
    shas.fix = commit('c.txt', 'fix on the line');
    git('update-ref', 'refs/remotes/origin/main', shas.merge);
    git('update-ref', 'refs/remotes/origin/release/0.10', shas.fix);
    git('update-ref', 'refs/remotes/origin/release/next', shas.unreviewed);
    process.env.GIT_DIR = join(dir, '.git');
  });

  afterAll(() => {
    if (previousGitDir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = previousGitDir;
    rmSync(dir, { recursive: true, force: true });
  });

  it("holds main's own commits", () => {
    expect(reviewedLinesHolding(shas.merge)).toEqual({ onMain: true, releaseLines: [] });
    expect(reviewedLinesHolding(shas.base)).toEqual({ onMain: true, releaseLines: ['0.10'] });
  });

  it('does not hold a commit merged in from a side branch, even one reverted before the merge', () => {
    expect(reviewedLinesHolding(shas.unreviewed)).toEqual({ onMain: false, releaseLines: [] });
  });

  it('holds a fix on its release line, and ignores a branch that is not release/X.Y', () => {
    expect(reviewedLinesHolding(shas.fix)).toEqual({ onMain: false, releaseLines: ['0.10'] });
  });
});
