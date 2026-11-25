import type { HandshakeAttestation } from '@d3-inc/d3-dna-protocol';

/**
 * What Cloudflare observed about a client certificate, as an attestation
 * (ADR 0021 decision 3). Read from `request.cf.tlsClientAuth`, which Cloudflare
 * fills from the TLS handshake it terminated — the reason this may be attested at
 * all. Never build one from a request header.
 *
 * Every field is a STRING here, and every string is truthy: `certPresented` is
 * `"1"` or `"0"`, `certRevoked` likewise, and `certVerified` is `"SUCCESS"`,
 * `"NONE"`, or `"FAILED:<reason>"`. Coercing any of them with `Boolean()` reads a
 * failed or absent certificate as a good one, which is why each is compared to
 * its exact value.
 *
 * Returns undefined when no certificate was presented: a handshake asserting
 * only `certPresented: false` says nothing the absence does not.
 */
export function handshakeFromTlsClientAuth(
  tls: IncomingRequestCfProperties['tlsClientAuth'] | undefined
): HandshakeAttestation | undefined {
  if (tls?.certPresented !== '1') return undefined;

  return {
    certPresented: true,
    certVerified: tls.certVerified === 'SUCCESS',
    certRevoked: tls.certRevoked === '1',
    ...pick('certFingerprintSHA256', tls.certFingerprintSHA256),
    ...pick('issuer', tls.certIssuerDNRFC2253),
    /*
     * Omitted when Cloudflare dropped it for size (10 KB leaf, 16 KB chain): the
     * field is then empty, and an empty string offered as a certificate would
     * fail the worker's fingerprint recompute instead of falling back to the
     * issuer check. RFC 9440 form (`:base64-DER:`) is passed through as given.
     */
    ...pick('certRFC9440', tls.certRFC9440TooLarge ? '' : tls.certRFC9440),
    ...pick('certChainRFC9440', tls.certChainRFC9440TooLarge ? '' : tls.certChainRFC9440),
  };
}

/** Cloudflare uses `''` for "not available"; an empty field must be absent, not empty. */
function pick<K extends string>(key: K, value: string): Partial<Record<K, string>> {
  return value === '' ? {} : ({ [key]: value } as Record<K, string>);
}
