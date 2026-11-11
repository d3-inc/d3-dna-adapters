// Node-run (`check-proven-mechanisms.ts`): both protocol files import nothing, so
// Node loads them from source.
import {
  ADAPTER_TYPE_ENDPOINTS,
  compareAdapterVersions,
  isAdapterType,
  isAdapterVersion,
  type AdapterType,
} from '../packages/protocol/src/adapter/adapter-name.ts';
import { isAdapterMechanism } from '../packages/protocol/src/adapter/mechanisms.ts';

/** One build's entry: from `since` on, a build sending `sends` does each mechanism its cited tests prove. */
export interface ProvenBuild {
  since: string;
  sends: number;
  proves: Record<string, string[]>;
}

/** `proven-mechanisms.json`: per type, its builds oldest first. */
export type ProvenMechanisms = Record<string, ProvenBuild[]>;

export interface RecordContext {
  /** The record on the branch a PR merges into; null on a push, which has nothing to compare. */
  base: ProvenMechanisms | null;
  source: (file: string) => string | null;
  /** The highest `v*` tag, without its `v`. */
  newestRelease: string | null;
  /** Each recipe type's current `dna-adapter` version. */
  recipeVersions: Readonly<Record<string, string>>;
}

// Where a type's own tests live. An SDK's protocol tests count, since the SDK runs that code.
const OWN_TESTS: Readonly<Record<AdapterType, readonly string[]>> = {
  cloudflare: ['packages/cloudflare-adapter/', 'packages/protocol/'],
  'vercel-middleware': ['packages/vercel-middleware/src/middleware.spec.ts', 'packages/protocol/'],
  'vercel-mcp': ['packages/vercel-middleware/src/mcp-route.spec.ts', 'packages/protocol/'],
  // From 2.0.0 the pasted file is packages/protocol bundled, so its tests cover
  // the code the snippet runs, exactly as they do for an SDK.
  snippet: ['cloudflare-snippet/', 'packages/protocol/'],
  openresty: ['openresty/test/'],
  caddy: ['caddy/test/'],
  nginx: ['nginx-auth-request/'],
};

const TEST_FILE = /(?:\.(?:spec|test)\.[cm]?[jt]s|\/test\/[^/]+)$/;

// Anything that keeps a runner from running a test, or makes it pass on failure.
const SKIPS =
  /\bx(?:it|test|describe)\(|\b(?:it|test|describe)(?:\.\w+)*\.(?:skip|todo|fails|skipIf|runIf)\b/;

// What may open a cited title: a vitest test, a recipe runner's check, or a parity case's name.
const OPENER = /(?:^|[^\w.])(?:it|test|check|ok)\($|\bname:$/;

/** A citation is `<repo file>: <test title as written in source>`. */
export function parseCitation(citation: string): { file: string; title: string } | null {
  const at = citation.indexOf(': ');
  if (at <= 0 || at + 2 >= citation.length) return null;

  return { file: citation.slice(0, at), title: citation.slice(at + 2) };
}

/**
 * Why a cited test proves nothing: its file is gone or holds no tests, the
 * file skips any test, or no test there opens with the title. Null when it runs.
 */
export function citationProblem(citation: string, source: (file: string) => string | null): string | null {
  const parsed = parseCitation(citation);
  if (parsed === null) return `"${citation}" is not "<file>: <test title>"`;

  if (!TEST_FILE.test(parsed.file)) return `${parsed.file} is not a test file`;

  const text = source(parsed.file);
  if (text === null) return `${parsed.file} does not exist`;

  if (SKIPS.test(text)) return `${parsed.file} skips a test, so none in it is cited`;

  if (!opensTest(text.split('\n'), parsed.title)) {
    return `${parsed.file} has no test titled "${parsed.title}"`;
  }

  return null;
}

/** Whether some test call or case name takes `title` as its first argument, on its line or the one before. */
function opensTest(lines: readonly string[], title: string): boolean {
  return lines.some((line, i) =>
    ["'", '"', '`'].some((quote) => {
      const at = line.indexOf(`${quote}${title}${quote}`);
      if (at === -1) return false;

      const before = line.slice(0, at).trimEnd();
      const opener = before.trim() === '' && i > 0 ? lines[i - 1].trimEnd() : before;
      return OPENER.test(opener) && !opener.includes('//') && !opener.trimStart().startsWith('*');
    })
  );
}

/**
 * Every way the record can claim more than the code proves: a type or
 * mechanism we do not define, builds out of order, a mechanism a type cannot
 * have, one with no running test of that build's own, a build proving fewer
 * than the one before it; and, against the base, a build re-scoped or removed,
 * or a new one for a version that is already out.
 */
export function provenMechanismProblems(record: ProvenMechanisms, context: RecordContext): string[] {
  const problems: string[] = [];
  for (const [type, builds] of Object.entries(record)) {
    if (!isAdapterType(type)) {
      problems.push(`${type}: not a type`);
      continue;
    }

    let previous: ProvenBuild | null = null;
    let lastVersion: string | null = null;
    for (const build of builds) {
      const at = `${type}@${build.since}`;
      if (!isAdapterVersion(build.since)) problems.push(`${at}: not a version`);
      else {
        if (lastVersion !== null && compareAdapterVersions(lastVersion, build.since) >= 0) {
          problems.push(`${at}: out of order`);
        }

        lastVersion = build.since;
      }

      if (!Number.isInteger(build.sends) || build.sends < 0) problems.push(`${at}: sends is not a revision`);

      if (typeof build.proves !== 'object' || build.proves === null) {
        problems.push(`${at}: proves is not a map`);
        continue;
      }

      for (const [mechanism, citations] of Object.entries(build.proves)) {
        problems.push(...mechanismProblems(type, at, mechanism, citations, context.source));
      }

      if (previous !== null) {
        const lost = Object.keys(previous.proves).filter(
          (mechanism) => !Object.hasOwn(build.proves, mechanism)
        );
        if (lost.length > 0) problems.push(`${at}: proves fewer than ${previous.since} (${lost.join(', ')})`);
      }

      previous = build;
    }
  }

  if (context.base === null) return problems;

  return [...problems, ...releasedBuildProblems(record, context.base), ...newBuildProblems(record, context)];
}

function mechanismProblems(
  type: AdapterType,
  at: string,
  mechanism: string,
  citations: readonly string[],
  source: (file: string) => string | null
): string[] {
  const problems: string[] = [];
  if (!isAdapterMechanism(mechanism)) problems.push(`${at}: ${mechanism} is not a mechanism`);

  if (impossibleFor(type).includes(mechanism)) problems.push(`${at}: ${type} cannot ${mechanism}`);

  if (citations.length === 0) problems.push(`${at}: ${mechanism} cites no test`);

  for (const citation of citations) {
    const file = parseCitation(citation)?.file;
    if (file !== undefined && !OWN_TESTS[type].some((own) => file.startsWith(own))) {
      problems.push(`${at}: ${mechanism}: ${file} does not test ${type}`);
      continue;
    }

    const problem = citationProblem(citation, source);
    if (problem !== null) problems.push(`${at}: ${mechanism}: ${problem}`);
  }

  return problems;
}

// No forward-auth hook rewrites a body, and Next middleware never holds the origin's.
function impossibleFor(type: AdapterType): readonly string[] {
  const forwardAuthOnly = ADAPTER_TYPE_ENDPOINTS[type].every((endpoint) => endpoint === 'forward-auth');
  return forwardAuthOnly || type === 'vercel-middleware' ? ['rewrite-body'] : [];
}

/** A build on the base branch may be re-cited, never re-scoped: the worker's row for it is already written. */
function releasedBuildProblems(record: ProvenMechanisms, base: ProvenMechanisms): string[] {
  const problems: string[] = [];
  for (const [type, builds] of Object.entries(base)) {
    for (const was of builds) {
      const now = (Object.hasOwn(record, type) ? record[type] : []).find(
        (build) => build.since === was.since
      );
      const at = `${type}@${was.since}`;
      if (now === undefined) {
        problems.push(`${at}: removed`);
        continue;
      }

      if (now.sends !== was.sends) problems.push(`${at}: sends changed from ${was.sends} to ${now.sends}`);

      const before = Object.keys(was.proves).sort().join(', ');
      const after = Object.keys(now.proves).sort().join(', ');
      if (before !== after) problems.push(`${at}: mechanisms changed from [${before}] to [${after}]`);
    }
  }

  return problems;
}

/**
 * A new build's tests ran against this commit, so it can only describe what
 * this commit ships: a recipe at its current version, an SDK above every tag.
 */
function newBuildProblems(record: ProvenMechanisms, context: RecordContext): string[] {
  const base = context.base ?? {};
  const problems: string[] = [];
  for (const [type, builds] of Object.entries(record)) {
    const was = Object.hasOwn(base, type) ? base[type] : [];
    for (const build of builds) {
      if (was.some((old) => old.since === build.since) || !isAdapterVersion(build.since)) continue;

      const at = `${type}@${build.since}`;
      if (Object.hasOwn(context.recipeVersions, type)) {
        const current = context.recipeVersions[type];
        if (build.since !== current) problems.push(`${at}: new, but the recipe is at ${current}`);
      } else if (
        context.newestRelease !== null &&
        compareAdapterVersions(build.since, context.newestRelease) <= 0
      ) {
        problems.push(`${at}: new, but ${context.newestRelease} is already tagged`);
      }
    }
  }

  return problems;
}
