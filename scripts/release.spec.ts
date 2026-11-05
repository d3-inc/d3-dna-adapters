import { describe, expect, it } from 'vitest';
import {
  distTagFor,
  isAcknowledgedHandPublish,
  oldRepoNameProblem,
  OLD_REPO_NAMES,
  packedManifestProblems,
  parseReleaseTag,
  provenanceCommit,
  provenanceProblem,
  publishDecision,
  publishIdentity,
  RETIRED_PACKAGES,
  sha512Integrity,
  unpublishedVersions,
  versionsSinceRetirement,
  type PackedManifest,
  type ProvenanceStatement,
} from './release.ts';

const onMain = { onMain: true, releaseLines: [] };

describe('parseReleaseTag', () => {
  it('reads a release and a prerelease', () => {
    expect(parseReleaseTag('v0.10.0')).toEqual({ version: '0.10.0', prerelease: false, line: '0.10' });
    expect(parseReleaseTag('v0.10.1-next.1')).toEqual({
      version: '0.10.1-next.1',
      prerelease: true,
      line: '0.10',
    });
  });

  it.each([
    '0.10.0',
    'v0.10',
    'v01.2.3',
    'v0.10.0-',
    'v0.10.0+build',
    'v0.10.0 ',
    'release-0.10',
    'v0.10.1-rc.1',
    'v0.10.1-latest',
    'v0.10.1-next.01',
    'v0.10.1-next',
  ])('refuses %j', (tag) => {
    expect(() => parseReleaseTag(tag)).toThrow('is not a release tag');
  });
});

describe('distTagFor', () => {
  it('publishes a release on main to latest, and a re-run of the same version too', () => {
    expect(distTagFor(parseReleaseTag('v0.11.0'), onMain, '0.10.2')).toBe('latest');
    expect(distTagFor(parseReleaseTag('v0.10.2'), onMain, '0.10.2')).toBe('latest');
    expect(distTagFor(parseReleaseTag('v0.10.0'), onMain, null)).toBe('latest');
  });

  it('refuses to move latest to a lower version', () => {
    expect(() => distTagFor(parseReleaseTag('v0.9.9'), onMain, '0.10.0')).toThrow('below latest 0.10.0');
  });

  it('publishes a prerelease on main to next', () => {
    expect(distTagFor(parseReleaseTag('v0.11.0-next.1'), onMain, '0.10.0')).toBe('next');
  });

  it('publishes a fix on a release branch under that line', () => {
    const onLine = { onMain: false, releaseLines: ['0.10'] };
    expect(distTagFor(parseReleaseTag('v0.10.3'), onLine, '0.11.0')).toBe('release-0.10');
  });

  it('refuses a commit that neither main nor its line holds', () => {
    const elsewhere = { onMain: false, releaseLines: ['0.9'] };
    expect(() => distTagFor(parseReleaseTag('v0.10.3'), elsewhere, null)).toThrow(
      'neither main nor release/0.10'
    );
    expect(() => distTagFor(parseReleaseTag('v0.10.3'), { onMain: false, releaseLines: [] }, null)).toThrow();
  });

  it('refuses a prerelease off main', () => {
    const onLine = { onMain: false, releaseLines: ['0.10'] };
    expect(() => distTagFor(parseReleaseTag('v0.10.3-next.1'), onLine, null)).toThrow('only main feeds');
  });
});

describe('packedManifestProblems', () => {
  const files = ['package.json', 'dist/index.js', 'dist/index.d.ts', 'README.md'];
  const expected = { name: '@d3-inc/d3-dna-cloudflare-adapter', version: '0.10.0' };
  const adapter = (overrides: Partial<PackedManifest> = {}): PackedManifest => ({
    name: '@d3-inc/d3-dna-cloudflare-adapter',
    version: '0.10.0',
    main: './dist/index.js',
    types: './dist/index.d.ts',
    exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
    dependencies: { '@d3-inc/d3-dna-protocol': '0.10.0' },
    ...overrides,
  });

  it('passes a packed SDK', () => {
    expect(packedManifestProblems(adapter(), expected, files)).toEqual([]);
  });

  it('refuses a workspace: or catalog: range in any dependency field', () => {
    const problems = packedManifestProblems(
      adapter({
        dependencies: { '@d3-inc/d3-dna-protocol': 'workspace:*' },
        peerDependencies: { vitest: 'catalog:' },
      }),
      expected,
      files
    );
    expect(problems).toContain(
      '@d3-inc/d3-dna-cloudflare-adapter dependencies.@d3-inc/d3-dna-protocol is workspace:*'
    );
    expect(problems).toContain('@d3-inc/d3-dna-cloudflare-adapter peerDependencies.vitest is catalog:');
  });

  it('refuses protocol at any version but this release', () => {
    const problems = packedManifestProblems(
      adapter({ dependencies: { '@d3-inc/d3-dna-protocol': '^0.10.0' } }),
      expected,
      files
    );
    expect(problems).toEqual([
      '@d3-inc/d3-dna-cloudflare-adapter depends on @d3-inc/d3-dna-protocol@^0.10.0, not 0.10.0',
    ]);
  });

  it('refuses a version other than the tag', () => {
    expect(packedManifestProblems(adapter({ version: '0.9.0' }), expected, files)).toEqual([
      '@d3-inc/d3-dna-cloudflare-adapter is 0.9.0, not 0.10.0',
    ]);
  });

  it('refuses a package other than the one its file should hold', () => {
    expect(
      packedManifestProblems(adapter({ name: '@d3-inc/d3-edge-cloudflare-adapter' }), expected, files)
    ).toEqual(['@d3-inc/d3-edge-cloudflare-adapter is not @d3-inc/d3-dna-cloudflare-adapter']);
    expect(
      packedManifestProblems(adapter({ name: '@d3-inc/d3-dna-protocol', dependencies: {} }), expected, files)
    ).toEqual(['@d3-inc/d3-dna-protocol is not @d3-inc/d3-dna-cloudflare-adapter']);
  });

  it('refuses an entry point the tarball does not ship', () => {
    const unpacked = adapter({ exports: { '.': { types: './src/index.ts', default: './src/index.ts' } } });
    expect(packedManifestProblems(unpacked, expected, files)).toEqual([
      '@d3-inc/d3-dna-cloudflare-adapter points at ./src/index.ts, which the tarball does not contain',
      '@d3-inc/d3-dna-cloudflare-adapter points at ./src/index.ts, which the tarball does not contain',
    ]);
  });
});

describe('publishDecision', () => {
  const local = sha512Integrity(new TextEncoder().encode('tarball'));

  it('publishes a version npm does not hold, and skips the same bytes', () => {
    expect(publishDecision(local, null, 'x@0.10.0')).toBe('publish');
    expect(publishDecision(local, local, 'x@0.10.0')).toBe('skip');
  });

  it('refuses a version npm holds with other contents', () => {
    const other = sha512Integrity(new TextEncoder().encode('a hand publish'));
    expect(() => publishDecision(local, other, 'x@0.10.0')).toThrow('already on npm with different contents');
  });
});

describe('provenanceProblem', () => {
  const built = (workflow: { ref?: string; repository?: string; path?: string }): ProvenanceStatement => ({
    predicateType: 'https://slsa.dev/provenance/v1',
    predicate: {
      buildDefinition: {
        externalParameters: { workflow },
        resolvedDependencies: [{ digest: { gitCommit: 'abc123' } }],
      },
    },
  });
  const ours = {
    ref: 'refs/tags/v0.10.1',
    repository: 'https://github.com/d3-inc/d3-dna-adapters',
    path: '.github/workflows/publish.yml',
  };

  it("passes a build from this repo's publish workflow on the version's own tag", () => {
    expect(provenanceProblem(built(ours), '0.10.1')).toBeNull();
    expect(provenanceCommit(built(ours))).toBe('abc123');
  });

  it('flags a build from another repo, another workflow, a branch, or another tag', () => {
    expect(
      provenanceProblem(built({ ...ours, repository: 'https://github.com/someone/fork' }), '0.10.1')
    ).toBe('was built in https://github.com/someone/fork');
    expect(provenanceProblem(built({ ...ours, path: '.github/workflows/test.yml' }), '0.10.1')).toBe(
      'was built by .github/workflows/test.yml'
    );
    expect(provenanceProblem(built({ ...ours, ref: 'refs/heads/main' }), '0.10.1')).toBe(
      'was built from refs/heads/main, not refs/tags/v0.10.1'
    );
    expect(provenanceProblem(built(ours), '0.10.2')).toBe(
      'was built from refs/tags/v0.10.1, not refs/tags/v0.10.2'
    );
  });

  it('flags provenance of another type, and reads no commit from it', () => {
    expect(provenanceProblem({ predicateType: 'https://example.com/other' }, '0.10.1')).toBe(
      'has provenance of type https://example.com/other'
    );
    expect(provenanceCommit({ predicateType: 'https://example.com/other' })).toBeNull();
  });

  it('signs as the publish workflow on the version tag', () => {
    expect(publishIdentity('0.10.1')).toBe(
      'https://github.com/d3-inc/d3-dna-adapters/.github/workflows/publish.yml@refs/tags/v0.10.1'
    );
  });
});

describe('npm history', () => {
  it('finds versions npm once held and no longer serves', () => {
    expect(unpublishedVersions({ versions: ['0.10.0'], published: ['0.10.0', '0.10.1'] })).toEqual([
      '0.10.1',
    ]);
    expect(unpublishedVersions({ versions: ['0.10.0'], published: ['0.10.0'] })).toEqual([]);
  });

  it('finds any version an old name gained after the rename', () => {
    const frozen = RETIRED_PACKAGES['@d3-inc/d3-edge-cloudflare-adapter'];
    expect(versionsSinceRetirement({ versions: [...frozen], published: [...frozen] }, frozen)).toEqual([]);
    expect(versionsSinceRetirement({ versions: [...frozen, '0.9.1'], published: [] }, frozen)).toEqual([
      '0.9.1',
    ]);
    expect(
      versionsSinceRetirement(
        { versions: ['0.0.1'], published: [] },
        RETIRED_PACKAGES['@d3-inc/d3-edge-protocol']
      )
    ).toEqual(['0.0.1']);
  });

  it('accepts a hand publish only with the bytes a PR acknowledged', () => {
    const acknowledged = { '@d3-inc/d3-dna-protocol': { '0.10.0': 'sha512-abc' } };
    expect(isAcknowledgedHandPublish(acknowledged, '@d3-inc/d3-dna-protocol', '0.10.0', 'sha512-abc')).toBe(
      true
    );
    expect(isAcknowledgedHandPublish(acknowledged, '@d3-inc/d3-dna-protocol', '0.10.0', 'sha512-other')).toBe(
      false
    );
    expect(isAcknowledgedHandPublish(acknowledged, '@d3-inc/d3-dna-protocol', '0.10.1', 'sha512-abc')).toBe(
      false
    );
    expect(isAcknowledgedHandPublish(acknowledged, '@d3-inc/d3-dna-protocol', '0.10.0', undefined)).toBe(
      false
    );
  });
});

describe('oldRepoNameProblem', () => {
  const [adapters, dna] = OLD_REPO_NAMES;

  it('passes a redirect to the new name', () => {
    expect(oldRepoNameProblem(adapters, { status: 200, fullName: 'd3-inc/d3-dna-adapters' })).toBeNull();
  });

  it('passes a 404 only where the new repo is private', () => {
    expect(oldRepoNameProblem(dna, { status: 404 })).toBeNull();
    expect(oldRepoNameProblem(adapters, { status: 404 })).toBe(
      'd3-inc/d3-edge-adapters answers 404, not d3-inc/d3-dna-adapters'
    );
  });

  it('flags a repo created under an old name', () => {
    expect(oldRepoNameProblem(adapters, { status: 200, fullName: 'd3-inc/d3-edge-adapters' })).toBe(
      'd3-inc/d3-edge-adapters is a repo of its own now'
    );
    expect(oldRepoNameProblem(dna, { status: 200, fullName: 'd3-inc/d3-edge' })).toBe(
      'd3-inc/d3-edge is a repo of its own now'
    );
  });
});
