import { createHash } from 'node:crypto';

/** What a release publishes, in order: both SDKs depend on protocol at the same version, so it goes first. */
export const RELEASE_PACKAGES = [
  { dir: 'protocol', name: '@d3-inc/d3-dna-protocol' },
  { dir: 'cloudflare-adapter', name: '@d3-inc/d3-dna-cloudflare-adapter' },
  { dir: 'vercel-middleware', name: '@d3-inc/d3-dna-vercel-middleware' },
] as const;

export const PROTOCOL_PACKAGE = RELEASE_PACKAGES[0].name;
export const CANONICAL_REPOSITORY = 'https://github.com/d3-inc/d3-dna-adapters';
export const PUBLISH_WORKFLOW = '.github/workflows/publish.yml';

/**
 * Versions put up by hand, by the integrity npm holds for each, acknowledged in a reviewed PR once
 * published. The registry check flags any other version without this repo's CI provenance, and any
 * listed version whose bytes differ.
 */
export const HAND_PUBLISHED: Readonly<Record<string, Readonly<Record<string, string>>>> = {};

/** Whether npm's bytes for a version match a hand publish a PR acknowledged. */
export const isAcknowledgedHandPublish = (
  acknowledged: typeof HAND_PUBLISHED,
  name: string,
  version: string,
  integrity: string | undefined
) => integrity !== undefined && acknowledged[name]?.[version] === integrity;

export interface ReleaseTag {
  version: string;
  prerelease: boolean;
  /** `major.minor`, the line a `release/<line>` branch fixes. */
  line: string;
}

/** `v0.10.0`, or `v0.10.1-next.1` for a prerelease; anything else throws. */
export function parseReleaseTag(tag: string): ReleaseTag {
  const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-next\.(?:0|[1-9]\d*))?$/.exec(tag);
  if (!match) throw new Error(`${tag} is not a release tag: use vX.Y.Z, or vX.Y.Z-next.N for a prerelease`);
  return { version: tag.slice(1), prerelease: match[4] !== undefined, line: `${match[1]}.${match[2]}` };
}

/** Compares two `X.Y.Z` release versions. */
export function compareReleases(a: string, b: string): number {
  const [pa, pb] = [a, b].map((v) => v.split('.').map(Number));
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }

  return 0;
}

export interface TaggedCommit {
  onMain: boolean;
  /** The `<line>` of every `release/<line>` branch that holds the commit. */
  releaseLines: readonly string[];
}

/**
 * The dist-tag a release publishes under. Throws for a commit no reviewed branch holds, a
 * prerelease off `main`, and a release that would move `latest` to a lower version. A version
 * equal to `latest` passes, so a half-failed run can be re-run.
 */
export function distTagFor(tag: ReleaseTag, commit: TaggedCommit, currentLatest: string | null): string {
  const onReleaseLine = commit.releaseLines.includes(tag.line);
  if (!commit.onMain && !onReleaseLine) {
    throw new Error(`the tagged commit is on neither main nor release/${tag.line}`);
  }

  if (tag.prerelease) {
    if (!commit.onMain) throw new Error('a prerelease publishes to next, which only main feeds');
    return 'next';
  }

  if (!commit.onMain) return `release-${tag.line}`;

  if (currentLatest !== null && compareReleases(tag.version, currentLatest) < 0) {
    throw new Error(
      `${tag.version} is below latest ${currentLatest}: tag a fix for an older line on release/${tag.line}`
    );
  }

  return 'latest';
}

export interface PackedManifest {
  name?: string;
  version?: string;
  main?: string;
  types?: string;
  exports?: unknown;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

const DEPENDENCY_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies'] as const;

function pathsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value];

  if (value && typeof value === 'object') return Object.values(value).flatMap(pathsIn);
  return [];
}

/**
 * What stops a packed tarball from publishing: a package other than the one its file should hold,
 * a version other than the tag's, a `workspace:` or `catalog:` range npm cannot resolve (0.3.0 shipped one), protocol
 * pinned to anything but this release, or an entry point the tarball does not contain.
 * `files` are the tarball's paths with the `package/` prefix removed.
 */
export function packedManifestProblems(
  manifest: PackedManifest,
  expected: { name: string; version: string },
  files: readonly string[]
): string[] {
  const { version } = expected;
  const problems: string[] = [];
  const label = manifest.name ?? '(no name)';
  if (manifest.name !== expected.name) problems.push(`${label} is not ${expected.name}`);

  if (manifest.version !== version) problems.push(`${label} is ${manifest.version}, not ${version}`);

  for (const field of DEPENDENCY_FIELDS) {
    for (const [dep, range] of Object.entries(manifest[field] ?? {})) {
      if (/^(?:workspace|catalog):/.test(range)) problems.push(`${label} ${field}.${dep} is ${range}`);
    }
  }

  const protocolRange = manifest.dependencies?.[PROTOCOL_PACKAGE];
  if (protocolRange !== undefined && protocolRange !== version) {
    problems.push(`${label} depends on ${PROTOCOL_PACKAGE}@${protocolRange}, not ${version}`);
  }

  const shipped = new Set(files);
  for (const entry of pathsIn([manifest.main, manifest.types, manifest.exports])) {
    const path = entry.replace(/^\.\//, '');
    if (!shipped.has(path)) problems.push(`${label} points at ${entry}, which the tarball does not contain`);
  }

  return problems;
}

/** A tarball's integrity in npm's `dist.integrity` form. */
export function sha512Integrity(tarball: Uint8Array): string {
  return `sha512-${createHash('sha512').update(tarball).digest('base64')}`;
}

/**
 * Whether to publish a tarball, given the integrity npm already holds for its version (null when
 * it holds none). The same bytes are skipped, so a re-run resumes; different bytes under a
 * published version throw.
 */
export function publishDecision(local: string, registry: string | null, label: string): 'publish' | 'skip' {
  if (registry === null) return 'publish';

  if (registry === local) return 'skip';
  throw new Error(`${label} is already on npm with different contents (${registry}); release a new version`);
}

/** The Sigstore identity CI signs a version's provenance with: this repo's publish workflow, on that version's tag. */
export const publishIdentity = (version: string) =>
  `${CANONICAL_REPOSITORY}/${PUBLISH_WORKFLOW}@refs/tags/v${version}`;

export interface ProvenanceStatement {
  predicateType?: string;
  predicate?: {
    buildDefinition?: {
      externalParameters?: { workflow?: { ref?: string; repository?: string; path?: string } };
      resolvedDependencies?: { digest?: { gitCommit?: string } }[];
    };
  };
}

/**
 * Why a version's provenance statement does not name this repo's publish workflow on that version's
 * tag, or null. Read it only after its signature checks out against `publishIdentity(version)`:
 * unsigned, the statement is whatever its publisher wrote.
 */
export function provenanceProblem(statement: ProvenanceStatement, version: string): string | null {
  if (statement.predicateType !== 'https://slsa.dev/provenance/v1') {
    return `has provenance of type ${statement.predicateType}`;
  }

  const workflow = statement.predicate?.buildDefinition?.externalParameters?.workflow;
  if (workflow?.repository !== CANONICAL_REPOSITORY) {
    return `was built in ${workflow?.repository ?? 'an unknown repo'}`;
  }

  if (workflow.path !== PUBLISH_WORKFLOW) return `was built by ${workflow.path ?? 'an unknown workflow'}`;

  if (workflow.ref !== `refs/tags/v${version}`) {
    return `was built from ${workflow.ref ?? 'an unknown ref'}, not refs/tags/v${version}`;
  }

  return null;
}

/** The commit a provenance statement says it was built from, or null. */
export const provenanceCommit = (statement: ProvenanceStatement): string | null =>
  statement.predicate?.buildDefinition?.resolvedDependencies?.[0]?.digest?.gitCommit ?? null;

/**
 * The names before the DNA rename, with every version each will ever have. An old name never gets
 * a trusted publisher, so a version beyond these is a hand publish no PR acknowledged.
 */
export const RETIRED_PACKAGES: Readonly<Record<string, readonly string[]>> = {
  '@d3-inc/d3-edge-cloudflare-adapter': [
    '0.1.0',
    '0.1.1',
    '0.2.0',
    '0.3.0',
    '0.3.1',
    '0.3.2',
    '0.4.0',
    '0.4.1',
    '0.5.0',
    '0.9.0',
  ],
  '@d3-inc/d3-edge-vercel-middleware': [
    '0.1.0',
    '0.2.0',
    '0.2.1',
    '0.2.2',
    '0.3.0',
    '0.3.1',
    '0.4.0',
    '0.8.0',
  ],
  '@d3-inc/d3-edge-core': ['0.1.0', '0.1.1', '0.2.0', '0.2.1', '0.2.2', '0.3.0', '0.3.1', '0.4.0', '0.8.0'],
  '@d3-inc/d3-edge-protocol': [],
};

export interface PackageHistory {
  /** The versions npm serves now. */
  versions: readonly string[];
  /** Every version npm has a publish time for, unpublished ones included. */
  published: readonly string[];
}

/** Versions npm once served and no longer does: no release unpublishes. */
export const unpublishedVersions = (history: PackageHistory) =>
  history.published.filter((v) => !history.versions.includes(v));

/** An old name's versions beyond the ones it had at the rename. */
export const versionsSinceRetirement = (history: PackageHistory, frozen: readonly string[]) =>
  history.versions.filter((v) => !frozen.includes(v));

export interface OldRepoName {
  old: string;
  current: string;
  /** A private repo reads as 404 to this repo's token, so only a public one can be seen to redirect. */
  currentIsPublic: boolean;
}

/** The names the repos had before the DNA rename. GitHub redirects each until a repo takes it. */
export const OLD_REPO_NAMES: readonly OldRepoName[] = [
  { old: 'd3-inc/d3-edge-adapters', current: 'd3-inc/d3-dna-adapters', currentIsPublic: true },
  { old: 'd3-inc/d3-edge', current: 'd3-inc/d3-dna', currentIsPublic: false },
];

/** Why GitHub's answer for an old name shows a repo has taken it, or null while it still redirects. */
export function oldRepoNameProblem(
  name: OldRepoName,
  answer: { status: number; fullName?: string }
): string | null {
  if (answer.status === 200 && answer.fullName === name.current) return null;

  if (answer.status === 404 && !name.currentIsPublic) return null;

  if (answer.status === 200 && answer.fullName === name.old) return `${name.old} is a repo of its own now`;
  return `${name.old} answers ${answer.status}${answer.fullName ? ` (${answer.fullName})` : ''}, not ${name.current}`;
}
