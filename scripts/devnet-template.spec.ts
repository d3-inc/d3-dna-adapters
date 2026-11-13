import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const CUSTOMER = 'cloudflare-worker';
const DEVNET = 'cloudflare-worker-devnet';
const DEVNET_ENDPOINT = 'https://edge-api-dev.d3.com/v1/decision';

// Tracked files only: an untracked `.dev.vars` or `node_modules` is not the template.
function tracked(directory: string): string[] {
  return execFileSync('git', ['ls-files', directory], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .map((file) => file.slice(directory.length + 1))
    .sort();
}

const read = (directory: string, file: string) => readFileSync(`${directory}/${file}`, 'utf8');

/** The customer template's file with the devnet template's three edits applied. */
const EXPECTED: Record<string, (customer: string) => string> = {
  'wrangler.toml': (customer) =>
    customer
      .replace('name = "d3-edge"\n', 'name = "d3-edge-devnet"\n')
      .replace(
        '[vars]\n',
        `[vars]\n# D3's internal devnet: without this line the worker calls production.\nDNA_ENDPOINT = "${DEVNET_ENDPOINT}"\n`
      ),
  '.dev.vars.example': (customer) =>
    customer.replace('https://dashboard.d3.com/keys', 'https://dashboard-dev.d3.com/keys'),
};

describe('the devnet worker template', () => {
  it('carries the files the customer template carries', () => {
    expect(tracked(DEVNET)).toEqual(tracked(CUSTOMER));
  });

  it.each(tracked(CUSTOMER).filter((file) => file !== 'README.md'))(
    'differs from the customer template in %s only where devnet does',
    (file) => {
      const expected = (EXPECTED[file] ?? ((customer) => customer))(read(CUSTOMER, file));
      expect(read(DEVNET, file)).toBe(expected);
    }
  );

  it('asks devnet, under [vars]', () => {
    // A line above the first table header is a top-level key, which wrangler does not bind.
    const vars = read(DEVNET, 'wrangler.toml').split('[vars]\n')[1];
    expect(vars).toContain(`DNA_ENDPOINT = "${DEVNET_ENDPOINT}"\n`);
  });

  it('leaves the customer template on the default endpoint', () => {
    expect(read(CUSTOMER, 'wrangler.toml')).not.toMatch(/^\s*DNA_ENDPOINT\b/m);
  });
});
