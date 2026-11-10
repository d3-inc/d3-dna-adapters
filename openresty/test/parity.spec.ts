import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildParity } from './parity.cases.ts';

const FILE = new URL('./parity.json', import.meta.url);

/** A long run of one character, as `{ $repeat, n }`: the Lua suite expands it back. */
const compactRuns = (_key: string, value: unknown) =>
  typeof value === 'string' && /^(.)\1{255,}$/s.test(value) ? { $repeat: value[0], n: value.length } : value;

// The Lua suite reads parity.json; this keeps it equal to what the package answers today.
// After a protocol change: UPDATE_PARITY=1 pnpm vitest run openresty/test/parity.spec.ts
describe('openresty/test/parity.json', () => {
  it('is what the protocol package answers', async () => {
    const fresh = `${JSON.stringify(await buildParity(), compactRuns, 2)}\n`;
    if (process.env.UPDATE_PARITY === '1') writeFileSync(FILE, fresh);

    expect(readFileSync(FILE, 'utf8')).toBe(fresh);
  });
});
