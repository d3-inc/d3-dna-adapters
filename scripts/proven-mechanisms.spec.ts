import { describe, expect, it } from 'vitest';
import {
  citationProblem,
  provenMechanismProblems,
  type ProvenMechanisms,
  type RecordContext,
} from './proven-mechanisms.ts';

const SNIPPET = 'cloudflare-snippet/snippet.spec.ts';
const FILES: Record<string, string> = {
  [SNIPPET]: [
    "it('forwards the pay session', () => {});",
    'it("answers in place of the origin", () => {});',
    "it('answers in place of the origin, and more', () => {});",
    'it(',
    "  'appends a Set-Cookie',",
    '  () => {}',
    ');',
    "// it('strips the visitor id', () => {});",
    "const label = 'keeps the site cookie';",
  ].join('\n'),
  'cloudflare-snippet/skipping.spec.ts':
    "describe.skip('d', () => { it('forwards the pay session', () => {}); });",
  'cloudflare-snippet/failing.spec.ts': "it.fails('forwards the pay session', () => {});",
  'caddy/test/run.mjs': "ok('to DNA: our cookies', a);\ncheck(`${scenario}: never the page`, b);",
  'openresty/test/parity.cases.ts': "  { name: 'ours ride outside the cap', input: 1 },",
  'packages/vercel-middleware/src/mcp-route.spec.ts': "it('puts the receipt in the result', () => {});",
  'package.json': '{ "scripts": { "test": "vitest" } }',
};
const source = (file: string) => FILES[file] ?? null;

const SESSION = `${SNIPPET}: forwards the pay session`;
const ANSWER = `${SNIPPET}: answers in place of the origin`;
const COOKIE = `${SNIPPET}: appends a Set-Cookie`;

describe('citationProblem', () => {
  it('accepts a title that opens a test, a check or a parity case, on its line or the one before', () => {
    for (const citation of [
      SESSION,
      ANSWER,
      COOKIE,
      'caddy/test/run.mjs: to DNA: our cookies',
      'caddy/test/run.mjs: ${scenario}: never the page',
      'openresty/test/parity.cases.ts: ours ride outside the cap',
    ]) {
      expect(citationProblem(citation, source), citation).toBeNull();
    }
  });

  it('refuses a title in a comment, in a plain string, or only the start of another', () => {
    expect(citationProblem(`${SNIPPET}: strips the visitor id`, source)).toMatch(/no test titled/);
    expect(citationProblem(`${SNIPPET}: keeps the site cookie`, source)).toMatch(/no test titled/);
    expect(citationProblem(`${SNIPPET}: answers in place`, source)).toMatch(/no test titled/);
  });

  it('refuses any test in a file that skips one, or inverts one', () => {
    expect(citationProblem('cloudflare-snippet/skipping.spec.ts: forwards the pay session', source)).toMatch(
      /skips a test/
    );
    expect(citationProblem('cloudflare-snippet/failing.spec.ts: forwards the pay session', source)).toMatch(
      /skips a test/
    );
  });

  it('refuses a file that is not a test, one that is gone, and a malformed citation', () => {
    expect(citationProblem('package.json: test', source)).toBe('package.json is not a test file');
    expect(citationProblem('cloudflare-snippet/gone.spec.ts: forwards', source)).toBe(
      'cloudflare-snippet/gone.spec.ts does not exist'
    );
    expect(citationProblem('forwards the pay session', source)).toMatch(/is not "<file>: <test title>"/);
  });
});

describe('provenMechanismProblems', () => {
  const build = (since: string, proves: Record<string, string[]>, sends = 1) => ({ since, sends, proves });
  const context = (over: Partial<RecordContext> = {}): RecordContext => ({
    base: null,
    source,
    newestRelease: '0.10.1',
    recipeVersions: { snippet: '1.1.0', caddy: '1.0.0' },
    ...over,
  });

  it('passes a record whose every mechanism cites a running test of its own build', () => {
    const record: ProvenMechanisms = {
      snippet: [
        build('1.0.0', { credentials: [SESSION] }),
        build('1.1.0', { credentials: [SESSION], answer: [ANSWER] }),
      ],
    };

    expect(provenMechanismProblems(record, context({ base: record }))).toEqual([]);
  });

  it('refuses each way the record can claim more than its tests prove', () => {
    const record = {
      snippet: [
        build('1.1.0', { credentials: [SESSION], answer: [ANSWER] }),
        build('1.0.0', { credentials: [SESSION] }),
        build('v2.0.0', { credentials: [SESSION], teleport: [SESSION] }),
        build('2.1.0', { credentials: [] }),
        build(
          '2.2.0',
          { credentials: [SESSION], decorate: ['caddy/test/run.mjs: to DNA: our cookies'] },
          1.5
        ),
        { since: '2.3.0', sends: 1 },
      ],
      caddy: [build('1.0.0', { 'rewrite-body': ['caddy/test/run.mjs: to DNA: our cookies'] }, 2)],
      'vercel-middleware': [
        build(
          '0.11.0',
          {
            'rewrite-body': [
              'packages/vercel-middleware/src/mcp-route.spec.ts: puts the receipt in the result',
            ],
          },
          2
        ),
      ],
      traefik: [build('1.0.0', {})],
    } as unknown as ProvenMechanisms;

    expect(provenMechanismProblems(record, context())).toEqual([
      'snippet@1.0.0: out of order',
      'snippet@1.0.0: proves fewer than 1.1.0 (answer)',
      'snippet@v2.0.0: not a version',
      'snippet@v2.0.0: teleport is not a mechanism',
      'snippet@2.1.0: credentials cites no test',
      'snippet@2.1.0: proves fewer than v2.0.0 (teleport)',
      'snippet@2.2.0: sends is not a revision',
      'snippet@2.2.0: decorate: caddy/test/run.mjs does not test snippet',
      'snippet@2.3.0: proves is not a map',
      'caddy@1.0.0: caddy cannot rewrite-body',
      'vercel-middleware@0.11.0: vercel-middleware cannot rewrite-body',
      'vercel-middleware@0.11.0: rewrite-body: packages/vercel-middleware/src/mcp-route.spec.ts does not test vercel-middleware',
      'traefik: not a type',
    ]);
  });

  it('lets a released build be re-cited, never re-scoped or removed', () => {
    const base: ProvenMechanisms = {
      snippet: [
        build('1.0.0', { credentials: [SESSION] }),
        build('1.1.0', { credentials: [SESSION], answer: [ANSWER] }),
      ],
      caddy: [build('1.0.0', { answer: ['caddy/test/run.mjs: to DNA: our cookies'] }, 2)],
    };
    const record: ProvenMechanisms = {
      snippet: [
        build('1.0.0', { credentials: [ANSWER] }),
        build('1.1.0', { credentials: [SESSION], answer: [ANSWER], decorate: [COOKIE] }, 2),
      ],
    };

    expect(provenMechanismProblems(record, context({ base }))).toEqual([
      'snippet@1.1.0: sends changed from 1 to 2',
      'snippet@1.1.0: mechanisms changed from [answer, credentials] to [answer, credentials, decorate]',
      'caddy@1.0.0: removed',
    ]);
  });

  it('dates a new build by what this commit ships: a recipe at its version, an SDK above every tag', () => {
    const record: ProvenMechanisms = {
      snippet: [build('1.0.0', { credentials: [SESSION] })],
      cloudflare: [
        build('0.10.1', { 'bare-pass': ['packages/protocol/src/x.spec.ts: never'] }, 3),
        build('0.11.0', { 'bare-pass': ['packages/protocol/src/x.spec.ts: never'] }, 3),
      ],
    };
    const ship = { ...FILES, 'packages/protocol/src/x.spec.ts': "it('never', () => {});" };

    expect(
      provenMechanismProblems(record, context({ base: {}, source: (file) => ship[file] ?? null }))
    ).toEqual([
      'snippet@1.0.0: new, but the recipe is at 1.1.0',
      'cloudflare@0.10.1: new, but 0.10.1 is already tagged',
    ]);
  });

  it('dates nothing on a push, which has no base to tell new from released', () => {
    const record: ProvenMechanisms = { snippet: [build('1.0.0', { credentials: [SESSION] })] };

    expect(provenMechanismProblems(record, context())).toEqual([]);
  });
});
