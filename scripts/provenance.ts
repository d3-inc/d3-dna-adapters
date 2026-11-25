// Keep out of smoke-release.ts and publish-release.ts: their jobs never install, so sigstore is not there.
import { verify } from 'sigstore';
import { REGISTRY, registryJson } from './registry.ts';
import type { ProvenanceStatement } from './release.ts';

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
