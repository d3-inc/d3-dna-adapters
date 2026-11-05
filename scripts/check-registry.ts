// registry-check.yml: flags an npm version no reviewed release put there, and an old repo name a repo has taken.
import { historyOf, packument, verifiedProvenance } from './registry.ts';
import { reviewedLinesHolding } from './release-plan.ts';
import {
  HAND_PUBLISHED,
  isAcknowledgedHandPublish,
  OLD_REPO_NAMES,
  oldRepoNameProblem,
  provenanceCommit,
  provenanceProblem,
  publishIdentity,
  RELEASE_PACKAGES,
  RETIRED_PACKAGES,
  unpublishedVersions,
  versionsSinceRetirement,
} from './release.ts';

const github = (path: string) =>
  fetch(`https://api.github.com/${path}`, {
    headers: {
      accept: 'application/vnd.github+json',
      ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
    },
  });

const heldByReviewedLine = (commit: string) => {
  const lines = reviewedLinesHolding(commit);
  return lines.onMain || lines.releaseLines.length > 0;
};

const problems: string[] = [];

for (const p of RELEASE_PACKAGES) {
  const doc = await packument(p.name);
  if (doc === null) {
    console.log(`${p.name}: not on npm yet`);
    continue;
  }

  for (const v of unpublishedVersions(historyOf(doc))) problems.push(`${p.name}@${v} was unpublished`);

  for (const [version, meta] of Object.entries(doc.versions ?? {})) {
    if (isAcknowledgedHandPublish(HAND_PUBLISHED, p.name, version, meta.dist?.integrity)) continue;

    const label = `${p.name}@${version}`;
    const result = await verifiedProvenance(meta.dist?.attestations?.url, publishIdentity(version));
    if ('problem' in result) {
      problems.push(`${label} ${result.problem}`);
      continue;
    }

    const problem = provenanceProblem(result.statement, version);
    if (problem) {
      problems.push(`${label} ${problem}`);
      continue;
    }

    const commit = provenanceCommit(result.statement);
    if (commit === null) problems.push(`${label} names no commit`);
    else if (!heldByReviewedLine(commit)) {
      problems.push(`${label} was built from ${commit}, which no reviewed line of main or release/* holds`);
    }
  }
}

for (const [name, frozen] of Object.entries(RETIRED_PACKAGES)) {
  const doc = await packument(name);
  if (doc === null) {
    if (frozen.length) problems.push(`${name} is gone from npm`);
    continue;
  }

  const history = historyOf(doc);
  for (const v of versionsSinceRetirement(history, frozen)) {
    problems.push(`${name}@${v} is new under a retired name`);
  }

  for (const v of unpublishedVersions(history)) problems.push(`${name}@${v} was unpublished`);
}

for (const name of OLD_REPO_NAMES) {
  const response = await github(`repos/${name.old}`);
  const body = response.ok ? ((await response.json()) as { full_name?: string }) : {};
  const problem = oldRepoNameProblem(name, { status: response.status, fullName: body.full_name });
  if (problem) problems.push(problem);
}

if (problems.length) {
  console.error(`::error::${problems.length} registry problem(s):\n- ${problems.join('\n- ')}`);
  process.exit(1);
}

console.log('Every version on npm came from a reviewed release, and both old repo names still redirect.');
