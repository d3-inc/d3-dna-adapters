// Whether dna.caddy's remote_ip line still lists Cloudflare's published ranges.
// `node caddy/test/cloudflare-ranges.mjs` exits non-zero on drift; the daily registry check runs it.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export async function cloudflareRangeDrift() {
  const published = (
    await Promise.all(
      ['ips-v4', 'ips-v6'].map(async (list) => {
        const res = await fetch(`https://www.cloudflare.com/${list}`);
        if (!res.ok) throw new Error(`cloudflare.com/${list}: ${res.status}`);
        return (await res.text()).trim().split('\n');
      })
    )
  ).flat();
  const recipe = readFileSync(new URL('../dna.caddy', import.meta.url), 'utf8');
  const listed = /^\s*remote_ip (.+)$/m.exec(recipe)?.[1].split(' ') ?? [];
  return {
    missing: published.filter((range) => !listed.includes(range)),
    extra: listed.filter((range) => !published.includes(range)),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { missing, extra } = await cloudflareRangeDrift();
  if (missing.length || extra.length) {
    console.error(
      `dna.caddy's Cloudflare ranges drifted. Add: ${missing.join(' ') || '-'}; remove: ${extra.join(' ') || '-'}`
    );
    process.exit(1);
  }

  console.log("dna.caddy lists Cloudflare's published ranges");
}
