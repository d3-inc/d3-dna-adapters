import { describe, expect, it } from 'vitest';
import { networkFactsFromCf } from './network-facts';

describe('networkFactsFromCf', () => {
  it('should relay the free request.cf fields, with the hello length as a number', () => {
    expect(
      networkFactsFromCf({
        asn: 15169,
        asOrganization: 'Google LLC',
        country: 'US',
        httpProtocol: 'HTTP/2',
        tlsVersion: 'TLSv1.3',
        tlsCipher: 'AEAD-AES128-GCM-SHA256',
        tlsClientHelloLength: '1685',
        tlsClientExtensionsSha1: 'ext=',
        tlsClientCiphersSha1: 'ciph=',
        clientTcpRtt: 12,
      } as unknown as IncomingRequestCfProperties)
    ).toEqual({
      asn: 15169,
      asOrganization: 'Google LLC',
      country: 'US',
      httpProtocol: 'HTTP/2',
      tlsVersion: 'TLSv1.3',
      tlsCipher: 'AEAD-AES128-GCM-SHA256',
      tlsClientHelloLength: 1685,
      tlsClientExtensionsSha1: 'ext=',
      tlsClientCiphersSha1: 'ciph=',
      clientTcpRttMs: 12,
    });
  });

  it('should send nothing without request.cf or with nothing usable on it', () => {
    expect(networkFactsFromCf(undefined)).toBeUndefined();
    expect(
      networkFactsFromCf({ tlsClientHelloLength: 'n/a' } as unknown as IncomingRequestCfProperties)
    ).toBeUndefined();
  });
});
