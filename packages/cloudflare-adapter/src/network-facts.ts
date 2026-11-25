import type { NetworkFacts } from '@d3-inc/d3-dna-protocol';

/**
 * The connection facts Cloudflare exposes on every plan, as the worker's
 * `network` block. `tlsClientHelloLength` arrives as a string. Undefined when
 * `request.cf` is absent (local dev, tests) so the payload stays as it was.
 */
export function networkFactsFromCf(cf: IncomingRequestCfProperties | undefined): NetworkFacts | undefined {
  if (!cf) return undefined;
  const helloLength = Number(cf.tlsClientHelloLength);
  const facts: NetworkFacts = {
    asn: cf.asn,
    asOrganization: cf.asOrganization,
    country: cf.country,
    httpProtocol: cf.httpProtocol,
    tlsVersion: cf.tlsVersion,
    tlsCipher: cf.tlsCipher,
    tlsClientHelloLength: Number.isInteger(helloLength) ? helloLength : undefined,
    tlsClientExtensionsSha1: stringOrUndefined(cf.tlsClientExtensionsSha1),
    tlsClientCiphersSha1: stringOrUndefined(cf.tlsClientCiphersSha1),
    clientTcpRttMs: cf.clientTcpRtt,
  };
  return Object.values(facts).some((v) => v !== undefined) ? facts : undefined;
}

/** workers-types leaves the two hash fields `unknown`. */
function stringOrUndefined(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
