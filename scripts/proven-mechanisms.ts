// Node-run (`check-proven-mechanisms.ts`): both protocol files import nothing, so
// Node loads them from source.
import {
  ADAPTER_TYPE_ENDPOINTS,
  compareAdapterVersions,
  isAdapterType,
  isAdapterVersion,
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

// A runner that skips a test still lists its title; these mark one it would skip.
const SKIPPED = /\b(?:x(?:it|test|describe)|(?:it|test|describe)\.(?:skip|todo|skipIf|runIf))\b/;

/** A citation is `<repo file>: <test title as written in source>`. */
export function parseCitation(citation: string): { file: string; title: string } | null {
  const at = citation.indexOf(': ');
  if (at <= 0 || at + 2 >= citation.length) return null;

  return { file: citation.slice(0, at), title: citation.slice(at + 2) };
}

/**
 * Why a cited test proves nothing: its file is gone, no string literal in it is
 * the title, or every line holding it is skipped. Null when it runs.
 */
export function citationProblem(citation: string, source: (file: string) => string | null): string | null {
  const parsed = parseCitation(citation);
  if (parsed === null) return `"${citation}" is not "<file>: <test title>"`;

  const text = source(parsed.file);
  if (text === null) return `${parsed.file} does not exist`;

  const lines = text.split('\n').filter((line) => quotes(line, parsed.title));
  if (lines.length === 0) return `${parsed.file} has no test titled "${parsed.title}"`;

  if (lines.every((line) => SKIPPED.test(line))) return `${parsed.file} skips "${parsed.title}"`;

  return null;
}

function quotes(line: string, title: string): boolean {
  return ["'", '"', '`'].some((quote) => line.includes(`${quote}${title}${quote}`));
}

/**
 * Every way the record can claim more than the code proves: a type or
 * mechanism we do not define, builds out of order, a mechanism with no running
 * test, `rewrite-body` on a forward-auth recipe, a build proving fewer than the
 * one before it, or a build `base` holds whose `sends` or mechanisms changed.
 */
export function provenMechanismProblems(
  record: ProvenMechanisms,
  base: ProvenMechanisms,
  source: (file: string) => string | null
): string[] {
  const problems: string[] = [];
  for (const [type, builds] of Object.entries(record)) {
    if (!isAdapterType(type)) {
      problems.push(`${type}: not a type`);
      continue;
    }

    const forwardAuthOnly = ADAPTER_TYPE_ENDPOINTS[type].every((endpoint) => endpoint === 'forward-auth');
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

      for (const [mechanism, citations] of Object.entries(build.proves)) {
        if (!isAdapterMechanism(mechanism)) problems.push(`${at}: ${mechanism} is not a mechanism`);

        if (forwardAuthOnly && mechanism === 'rewrite-body') {
          problems.push(`${at}: rewrite-body on forward-auth`);
        }

        if (citations.length === 0) problems.push(`${at}: ${mechanism} cites no test`);

        for (const citation of citations) {
          const problem = citationProblem(citation, source);
          if (problem !== null) problems.push(`${at}: ${mechanism}: ${problem}`);
        }
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

  return [...problems, ...releasedBuildProblems(record, base)];
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
