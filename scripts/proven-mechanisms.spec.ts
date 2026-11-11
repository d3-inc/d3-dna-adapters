import { describe, expect, it } from 'vitest';
import { citationProblem, provenMechanismProblems, type ProvenMechanisms } from './proven-mechanisms.ts';

const FILES: Record<string, string> = {
  'a.spec.ts': [
    "it('forwards the pay session', () => {});",
    "it.skip('appends a Set-Cookie', () => {});",
    'it("answers in place of the origin", () => {});',
    "it('answers in place of the origin, and more', () => {});",
  ].join('\n'),
  'run.mjs': "check('to DNA: names this file\\'s build', ok);\ncheck(`pass: keeps our cookies`, ok);",
};
const source = (file: string) => FILES[file] ?? null;

const SESSION = 'a.spec.ts: forwards the pay session';
const ANSWER = 'a.spec.ts: answers in place of the origin';

describe('citationProblem', () => {
  it('accepts a title any quote style holds', () => {
    expect(citationProblem(SESSION, source)).toBeNull();
    expect(citationProblem(ANSWER, source)).toBeNull();
    expect(citationProblem('run.mjs: pass: keeps our cookies', source)).toBeNull();
  });

  it('refuses a title that only starts another one', () => {
    expect(citationProblem('a.spec.ts: answers in place', source)).toMatch(/no test titled/);
  });

  it('refuses a missing file, a missing title and a malformed citation', () => {
    expect(citationProblem('gone.spec.ts: forwards the pay session', source)).toBe(
      'gone.spec.ts does not exist'
    );
    expect(citationProblem('a.spec.ts: strips the pay session', source)).toMatch(/no test titled/);
    expect(citationProblem('forwards the pay session', source)).toMatch(/is not "<file>: <test title>"/);
  });

  it('refuses a skipped test', () => {
    expect(citationProblem('a.spec.ts: appends a Set-Cookie', source)).toBe(
      'a.spec.ts skips "appends a Set-Cookie"'
    );
  });
});

describe('provenMechanismProblems', () => {
  const build = (since: string, proves: Record<string, string[]>, sends = 1) => ({ since, sends, proves });

  it('passes a record whose every mechanism cites a running test', () => {
    const record: ProvenMechanisms = {
      snippet: [
        build('1.0.0', { credentials: [SESSION] }),
        build('1.1.0', { credentials: [SESSION], answer: [ANSWER] }),
      ],
    };

    expect(provenMechanismProblems(record, record, source)).toEqual([]);
  });

  it('refuses each way the record can claim more than its tests prove', () => {
    const record = {
      snippet: [
        build('1.1.0', { credentials: [SESSION], answer: [ANSWER] }),
        build('1.0.0', { credentials: [SESSION] }),
        build('v2.0.0', { credentials: [SESSION], teleport: [SESSION] }),
        build('2.1.0', { credentials: [] }),
        build('2.2.0', { credentials: [SESSION], decorate: ['a.spec.ts: appends a Set-Cookie'] }, 1.5),
      ],
      caddy: [build('1.0.0', { 'rewrite-body': [SESSION] }, 2)],
      traefik: [build('1.0.0', {})],
    } as ProvenMechanisms;

    expect(provenMechanismProblems(record, {}, source)).toEqual([
      'snippet@1.0.0: out of order',
      'snippet@1.0.0: proves fewer than 1.1.0 (answer)',
      'snippet@v2.0.0: not a version',
      'snippet@v2.0.0: teleport is not a mechanism',
      'snippet@2.1.0: credentials cites no test',
      'snippet@2.1.0: proves fewer than v2.0.0 (teleport)',
      'snippet@2.2.0: sends is not a revision',
      'snippet@2.2.0: decorate: a.spec.ts skips "appends a Set-Cookie"',
      'caddy@1.0.0: rewrite-body on forward-auth',
      'traefik: not a type',
    ]);
  });

  it('lets a released build be re-cited, never re-scoped or removed', () => {
    const base: ProvenMechanisms = {
      snippet: [
        build('1.0.0', { credentials: [SESSION] }),
        build('1.1.0', { credentials: [SESSION], answer: [ANSWER] }),
      ],
      openresty: [build('1.0.0', { answer: [ANSWER] }, 3)],
    };
    const record: ProvenMechanisms = {
      snippet: [
        build('1.0.0', { credentials: ['run.mjs: pass: keeps our cookies'] }),
        build('1.1.0', { credentials: [SESSION], answer: [ANSWER], decorate: [ANSWER] }, 2),
      ],
    };

    expect(provenMechanismProblems(record, base, source)).toEqual([
      'snippet@1.1.0: sends changed from 1 to 2',
      'snippet@1.1.0: mechanisms changed from [answer, credentials] to [answer, credentials, decorate]',
      'openresty@1.0.0: removed',
    ]);
  });

  it('lets a release line add a build between two others', () => {
    const base: ProvenMechanisms = {
      snippet: [
        build('1.0.0', { credentials: [SESSION] }),
        build('1.2.0', { credentials: [SESSION], answer: [ANSWER] }),
      ],
    };
    const record: ProvenMechanisms = {
      snippet: [
        base.snippet[0],
        build('1.1.1', { credentials: [SESSION], answer: [ANSWER] }),
        base.snippet[1],
      ],
    };

    expect(provenMechanismProblems(record, base, source)).toEqual([]);
  });
});
