import { describe, expect, it } from 'vitest';
import { handshakeFromTlsClientAuth } from './handshake';

type Tls = NonNullable<IncomingRequestCfProperties['tlsClientAuth']>;

/** A presented, verified certificate, as Cloudflare reports one. */
function tls(over: Partial<Tls> = {}): Tls {
  return {
    certPresented: '1',
    certVerified: 'SUCCESS',
    certRevoked: '0',
    certIssuerDN: 'CN=ANS CA, O=GoDaddy',
    certSubjectDN: 'CN=shop.example',
    certIssuerDNRFC2253: 'CN=ANS CA,O=GoDaddy',
    certSubjectDNRFC2253: 'CN=shop.example',
    certIssuerDNLegacy: '',
    certSubjectDNLegacy: '',
    certSerial: '01',
    certIssuerSerial: '02',
    certSKI: 'ab',
    certIssuerSKI: 'cd',
    certFingerprintSHA1: 'dead',
    certFingerprintSHA256: 'beef',
    certNotBefore: 'Dec 22 19:39:00 2026 GMT',
    certNotAfter: 'Dec 22 19:39:00 2027 GMT',
    certRFC9440: ':TUlJQg==:',
    certRFC9440TooLarge: false,
    certChainRFC9440: ':TUlJQw==:,:TUlJRA==:',
    certChainRFC9440TooLarge: false,
    ...over,
  } as Tls;
}

describe('handshakeFromTlsClientAuth', () => {
  it('should attest a presented, verified certificate', () => {
    expect(handshakeFromTlsClientAuth(tls())).toEqual({
      certPresented: true,
      certVerified: true,
      certRevoked: false,
      certFingerprintSHA256: 'beef',
      issuer: 'CN=ANS CA,O=GoDaddy',
      certRFC9440: ':TUlJQg==:',
      certChainRFC9440: ':TUlJQw==:,:TUlJRA==:',
    });
  });

  it('should attest nothing when no certificate was presented', () => {
    expect(handshakeFromTlsClientAuth(undefined)).toBeUndefined();
    // The placeholder Cloudflare substitutes on a zone with mTLS configured but no
    // client cert on this request. `certPresented: '0'` is a truthy STRING.
    expect(handshakeFromTlsClientAuth(tls({ certPresented: '0' }))).toBeUndefined();
  });

  /**
   * Every field arrives as a string and every string is truthy, so a `Boolean()`
   * coercion anywhere here reads a failed certificate as a good one — and
   * `certVerified` plus a pinned issuer is what lets an ANS staple prove.
   */
  it.each([
    ['NONE'],
    ['FAILED'],
    ['FAILED:self signed certificate'],
    ['FAILED:certificate has expired'],
  ] as const)('should not call a %s verification result verified', (certVerified) => {
    expect(handshakeFromTlsClientAuth(tls({ certVerified }))).toMatchObject({
      certPresented: true,
      certVerified: false,
    });
  });

  it('should read a revoked certificate as revoked, from the string "1"', () => {
    expect(handshakeFromTlsClientAuth(tls({ certRevoked: '1' }))).toMatchObject({ certRevoked: true });
  });

  /**
   * Cloudflare empties the field and sets the TooLarge flag past 10 KB (leaf) and
   * 16 KB (chain). Offering `''` as a certificate would fail the worker's
   * fingerprint recompute instead of falling back to the issuer check.
   */
  it('should omit a certificate Cloudflare dropped for size', () => {
    const big = handshakeFromTlsClientAuth(
      tls({ certRFC9440TooLarge: true, certChainRFC9440TooLarge: true })
    );
    expect(big).not.toHaveProperty('certRFC9440');
    expect(big).not.toHaveProperty('certChainRFC9440');
    expect(big).toMatchObject({ certPresented: true, certFingerprintSHA256: 'beef' });
  });

  it('should omit every field Cloudflare reports as empty rather than sending it empty', () => {
    const bare = handshakeFromTlsClientAuth(
      tls({ certFingerprintSHA256: '', certIssuerDNRFC2253: '', certRFC9440: '', certChainRFC9440: '' })
    );
    expect(bare).toEqual({ certPresented: true, certVerified: true, certRevoked: false });
  });

  it('should never report a SAN: Cloudflare exposes none, and a guessed one would refute a real agent', () => {
    expect(handshakeFromTlsClientAuth(tls())).not.toHaveProperty('san');
  });
});
