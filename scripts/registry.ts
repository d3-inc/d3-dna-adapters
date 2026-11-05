import { verify } from 'sigstore';
import type { PackageHistory, ProvenanceStatement } from './release.ts';

const REGISTRY = 'https://registry.npmjs.org';

/** A registry document, or null when npm has none. The CDN serves stale copies unless told not to. */
async function registryJson(path: string): Promise<Record<string, unknown> | null> {
  const response = await fetch(`${REGISTRY}/${path}`, {
    headers: { accept: 'application/json', 'cache-control': 'no-cache' },
  });
  if (response.status === 404) return null;

  if (!response.ok) throw new Error(`npm answered ${response.status} for ${path}`);
  return (await response.json()) as Record<string, unknown>;
}

const encoded = (name: string) => name.replace('/', '%2F');

export interface Packument {
  'dist-tags'?: Record<string, string>;
  versions?: Record<string, { dist?: { integrity?: string; attestations?: { url?: string } } }>;
  time?: Record<string, string>;
}

export async function packument(name: string): Promise<Packument | null> {
  return (await registryJson(encoded(name))) as Packument | null;
}

export const historyOf = (doc: Packument): PackageHistory => ({
  versions: Object.keys(doc.versions ?? {}),
  published: Object.keys(doc.time ?? {}).filter((key) => key !== 'created' && key !== 'modified'),
});

// The packument is cached at npm's CDN for minutes whatever the request says; this endpoint is not.
export async function latestVersion(name: string): Promise<string | null> {
  const response = await fetch(`${REGISTRY}/-/package/${encoded(name)}/dist-tags`, {
    headers: { accept: 'application/json' },
  });
  if (response.ok) return ((await response.json()) as Record<string, string>).latest ?? null;

  // npm answers 401, not 404, for a scoped name it has never seen.
  if ((response.status === 401 || response.status === 404) && (await packument(name)) === null) return null;
  throw new Error(`npm answered ${response.status} for ${name}'s dist-tags`);
}

export async function versionIntegrity(name: string, version: string): Promise<string | null> {
  const doc = (await registryJson(`${encoded(name)}/${version}`)) as { dist?: { integrity?: string } } | null;
  return doc?.dist?.integrity ?? null;
}

interface Attestations {
  attestations?: { predicateType?: string; bundle?: { dsseEnvelope?: { payload?: string } } }[];
}

/**
 * A version's provenance statement, once Sigstore confirms GitHub Actions signed it as `identity`;
 * otherwise why it falls short. The statement alone proves nothing: anyone can write one.
 */
export async function verifiedProvenance(
  attestationsUrl: string | undefined,
  identity: string
): Promise<{ statement: ProvenanceStatement } | { problem: string }> {
  if (!attestationsUrl?.startsWith(`${REGISTRY}/`)) return { problem: 'has no provenance' };

  const doc = (await registryJson(attestationsUrl.slice(REGISTRY.length + 1))) as Attestations | null;
  const slsa = doc?.attestations?.find((a) => a.predicateType === 'https://slsa.dev/provenance/v1');
  const payload = slsa?.bundle?.dsseEnvelope?.payload;
  if (!slsa?.bundle || !payload) return { problem: 'has no provenance' };

  try {
    await verify(slsa.bundle as Parameters<typeof verify>[0], {
      certificateIssuer: 'https://token.actions.githubusercontent.com',
      certificateIdentityURI: identity,
    });
  } catch (error) {
    return { problem: `has provenance not signed as ${identity} (${(error as Error).message})` };
  }

  return { statement: JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as ProvenanceStatement };
}
