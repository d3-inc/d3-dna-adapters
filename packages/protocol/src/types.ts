/**
 * The contract between all D3 Edge components (design doc §4.1 / §6).
 * This package must stay free of platform imports — it runs inside our outer
 * worker today (approach 1) and inside the customer's inner worker after the
 * approach-2 migration.
 *
 * `RequestPayload`, `ClientDecision` and `ResponseReport` are also implemented
 * by hand — no compiler, no shared package — by the copy-paste adapters in
 * github.com/d3-inc/d3-dna-adapters, whose PROTOCOL.md specifies them for
 * third parties. Renaming or narrowing a field here breaks installs already
 * running on customer infrastructure; land the matching PR in that repo.
 */

import type { AnsStatus } from './ans';
import type { Purpose } from './purpose';
import type { AppliedAction } from './rules';

/**
 * Identity tiers in strength order (strongest first). This array is the single
 * source of truth for both the `Tier` union and any strength ranking (e.g. the
 * dashboard's "best tier" reducer) — derive from it, never re-list the tiers.
 */
export const TIERS = ['proven', 'claimed', 'derived', 'spoofed', 'unverified'] as const;

export type Tier = (typeof TIERS)[number];

/**
 * The waterfall step that established a `proven` identity, in precedence order
 * (strongest first): an HTTP message signature beats ANS certificate possession
 * (one rung, two carriers), which beats an operator IP range or a forward-confirmed
 * reverse-DNS name (ADR 0059). Policy can refuse to trust either (see PolicyTrust).
 */
export type VerificationMethod =
  'http-message-signature' | 'ans-mtls' | 'ans-dpop' | 'ip-range' | 'reverse-dns' | 'wallet-signature';

export type Reason =
  | 'ok'
  | 'no-signature'
  | 'malformed-payload'
  | 'missing-headers'
  | 'bad-signature-input'
  | 'unsupported-alg'
  | 'wrong-tag'
  | 'insufficient-coverage'
  | 'not-yet-valid'
  | 'expired'
  | 'stale'
  | 'unknown-key'
  | 'invalid-signature'
  | 'authority-mismatch'
  | 'identity-mismatch'
  | 'body-unattested'
  | 'ans-staple'
  | 'ans-token-expired'
  | 'ans-revoked'
  | 'ans-receipt-unverifiable'
  | 'ans-dpop-unverifiable'
  // An ERC-1271 contract, or an unprobed kind: cannot prove or refute at request time (ADR 0023 decision 4).
  | 'wallet-unverifiable'
  | 'internal-error';

/** The forwarded request metadata assembled by the inner worker. */
export interface RequestPayload {
  /** Correlation id (≤64 chars) linking the decision to its response report. */
  requestId?: string;
  /** Used transiently for derived-tier matching; hashed before storage. */
  ip?: string;
  method: string;
  /** Request target: path + optional query (→ @path / @query), e.g. "/v1/x?y=1". */
  url: string;
  /** HTTP Host / authority (→ @authority). */
  host: string;
  /** When the upstream observed the request (ISO-8601 or epoch seconds). Informational. */
  timestamp?: string | number;
  /**
   * Headers of the agent's request, lowercase-keyed. Signature headers are
   * optional — unsigned traffic is classified (derived/unverified), not rejected.
   * Must include any header covered by Signature-Input so the signature base
   * can be reconstructed.
   */
  headers: Record<string, string>;
  /**
   * Every header but the credentials, sent only under the adapter's
   * `DEBUG_LOG_RAW_PAYLOAD` for the request record; nothing that verifies reads it.
   */
  debugHeaders?: Record<string, string>;
  /** Adapter-attested TLS handshake; absent until an adapter attests (ADR 0007 decision 9). */
  handshake?: HandshakeAttestation;
  /** What the platform saw of the visitor's connection; absent off Cloudflare and Vercel (ADR 0020 record only). */
  network?: NetworkFacts;
  /** `FORWARDED_HEADER_SET` of the adapter that built this: which header families its absence can speak for (ADR 0060). */
  headerSet?: number;
  /** `ADAPTER_SET` of the adapter that built this: what it does with our answer, so the worker knows a browser check can complete (ADR 0068). */
  adapterSet?: number;
  /** Whether the visitor reached the site over HTTPS. Chrome sends client hints and `Sec-Fetch-*` only to a secure origin, so their absence means nothing without this. */
  secure?: boolean;
  /** Forwarded headers the adapter dropped for length: present on the wire, so their absence is the cap's, not the visitor's. */
  droppedHeaders?: string[];
}

/**
 * Connection facts an adapter reads from its platform (`request.cf` on
 * Cloudflare, `geolocation()` on Vercel). Logged on the request record and
 * never read by a verifier: an adapter is trusted to relay them, not to prove
 * them. TLS fields are what Cloudflare exposes on every plan.
 */
export interface NetworkFacts {
  asn?: number;
  asOrganization?: string;
  /** ISO 3166-1 alpha-2, or Cloudflare's `T1` for Tor. */
  country?: string;
  httpProtocol?: string;
  tlsVersion?: string;
  tlsCipher?: string;
  tlsClientHelloLength?: number;
  tlsClientExtensionsSha1?: string;
  tlsClientCiphersSha1?: string;
  clientTcpRttMs?: number;
}

/** What the TLS-terminating adapter attests about a client handshake — combiner input, never re-derived at the worker. */
export interface HandshakeAttestation {
  /** Recorded, decides nothing: the adapter's CA is not ours. */
  chainValidated?: boolean;
  san?: string;
  /** Absent/false ⇒ the ans ceiling stays `claimed`. */
  certPresented?: boolean;
  /** CA-relative: possibly the customer's own CA, so true still faces the issuer guard. */
  certVerified?: boolean;
  /** A valid-but-revoked cert never proves. */
  certRevoked?: boolean;
  /** Hex or `SHA256:<hex>`; normalized at compare. */
  certFingerprintSHA256?: string;
  issuer?: string;
  certRFC9440?: string;
  certChainRFC9440?: string;
}

export type KeySource = 'preloaded' | 'web-bot-auth-dir' | 'manual';

/**
 * Provenance of a verdict's identity string. Only 'origin' — the claimed
 * Signature-Agent hostname — gets the signed-but-lying spoof check.
 */
export type IdentitySource = 'curated' | 'origin' | 'keyid';

// Confidence in OUR purpose answer, stored raw (ADR 0001 §2b); the identity floor (§3)
// is applied at matching/render, never stored. Only proven/unverified are produced today
// (`derived` is reserved). Strongest first — derive the union, never re-list (as with TIERS).
export const PURPOSE_TIERS = ['proven', 'derived', 'unverified'] as const;

export type PurposeTier = (typeof PURPOSE_TIERS)[number];

/** Where a purpose claim arrived (ADR 0001 §4): the signed key directory, or an anonymous request header. */
export type PurposeClaimedSource = 'key-directory' | 'header';

/** Evidence behind a `derived` match: UA claim, UA confirmed by operator IP range or reverse DNS, or IP range alone. */
export type DerivedBasis = 'ua' | 'ua+ip' | 'ua+dns' | 'ip';

/** The verifier core's output — pure data, consumed by the policy engine and logs. */
export interface Verdict {
  verified: boolean;
  tier: Tier;
  reason: Reason;
  /** Which waterfall step proved the identity; only set on `proven` verdicts. */
  verifiedBy?: VerificationMethod;
  /** Source list behind a fingerprint-based verdict (proven-by-ip-range, derived, spoofed). */
  botSource?: string;
  /** Canonical agent name when known, else the signature-agent FQDN. */
  identity?: string;
  identitySource?: IdentitySource;
  /** Pre-canonicalization matched name; only set when projection changed it. */
  rawIdentity?: string;
  /** OUR answer: the purposes we assert this bot serves (ADR 0001 §3/§4). Empty ⇒ no curated answer (rendered `unknown`). */
  purpose?: Purpose[];
  /** Confidence in our answer, stored raw; the identity floor is applied at matching/render time (§2b/§3). */
  purposeTier?: PurposeTier;
  /** THEIR claim: what the request/directory declared, mapped where recognised and kept verbatim otherwise (§4/§5). */
  purposeClaimed?: string[];
  /** Where the claim arrived — a signed key directory beats an anonymous header (§4). */
  purposeClaimedSource?: PurposeClaimedSource;
  /** True when a recognised claim falls outside our COMPLETE answer — a bot caught lying (§7). Derived, not stored. */
  purposeContradicted?: boolean;
  keyid?: string;
  /** Match basis on `derived` verdicts. 'ua' is an unconfirmed claim — spoofable, unlike 'ua+ip'/'ip'. */
  derivedFrom?: DerivedBasis;
  signatureAgent?: string;
  algorithm?: string;
  coveredComponents?: string[];
  created?: number;
  expires?: number;
  keySource?: KeySource;
  /** Set on `claimed` verdicts: the caller should enqueue an async directory fetch. */
  needsKeyFetch?: boolean;
  /** Set on a `derived` claim for a masked agent the host's cache could not decide: resolve the address after the response (ADR 0059). */
  needsReverseDns?: boolean;
  /** Verified ANS enrichment (ADR 0021 decision 3): rides along, never a tier. */
  ansName?: string;
  /** The bot_source slug of the registry whose pinned root key verified the staple — the ans_registry. */
  ansRegistry?: string;
  /** The verified status token's Status, as signed (ACTIVE|DEPRECATED|WARNING|REVOKED|EXPIRED). */
  ansStatus?: AnsStatus;
  /** Set when a present staple's token hash is not yet resolved: the caller enqueues the waitUntil verify. */
  needsAnsFetch?: boolean;
  /** The resolver key this request's staple hashed to, so the enqueued verify does not re-digest a header capped at 1 MiB. Set with `needsAnsFetch`. */
  ansTokenHash?: string;
  /** Set when a presented cert fingerprint-matched but needs our own X.509 chain validation before it can prove: the caller enqueues the waitUntil validate. */
  needsAnsChainValidation?: boolean;
}

/**
 * Adapter-key auth outcomes on the wire (adapter-keys-plan D11), returned as
 * `{ "error": <reason> }`. 401: unknown-key | expired | revoked. 503:
 * not-configured. `expired`/`revoked` only ever surface after a digest match,
 * so nothing is disclosed to guessers; the status mapping lives with the
 * routes' auth module, not here.
 *
 * There is no 403. `host-not-allowed` was the host-scope gate's rejection and
 * the gate is gone — a valid key may report any host. Leaving it here had
 * adapter authors handling a status the server can no longer return.
 */
export type AdapterAuthReason = 'unknown-key' | 'unknown-zone' | 'expired' | 'revoked' | 'not-configured';

/** What a decision says it applied (ADR 0066); `log-only` arrives only from a worker older than that. */
export type PolicyRuleAction = AppliedAction | 'log-only';

/** What the inner worker actually does. */
export type Enforcement = 'pass' | 'block';

/** Only hot-path (`live`) decisions exist today. */
export type DecisionSource = 'live';

/**
 * The `x-d3-edge` outcome tag an adapter reports back (`disabled` sends no
 * report). `parseReport` validates against this tuple, so a value added here
 * needs no second edit to be legal.
 */
export const EDGE_MODES = [
  'pass',
  'block',
  'fail-open',
  'fail-closed',
  'payment-required',
  'payment-redirect',
  'payment-stub',
] as const;

export type EdgeMode = (typeof EDGE_MODES)[number];

/** A response the adapter built rather than proxied, as the report carries it. */
export interface BuiltAnswer {
  headers: Record<string, string>;
  /** Absent for a redirect. */
  body?: string;
}

/** Outcome of one enforced request, reported by the adapter after responding. */
export interface ResponseReport {
  /** Correlation id from the decision payload (the request event's `decision_id`). */
  requestId: string;
  /** Epoch ms. */
  ts: number;
  host: string;
  path: string;
  method: string;
  mode: EdgeMode;
  /** Status returned to the client; unset when the adapter doesn't terminate the response (Vercel pass). */
  status?: number;
  /** Origin round-trip ms; unset when the origin was never contacted. */
  originLatencyMs?: number;
  contentType?: string;
  /**
   * Response body bytes: the Content-Length header when the origin declares
   * one (wire bytes), else counted from the stream (decoded bytes). Unset when
   * the adapter never sees the response body (Vercel).
   */
  contentLength?: number;
  /** The answer the adapter built itself (a 402, 302, 502 or 403); absent when the origin answered. */
  answer?: BuiltAnswer;
}

/** Request attributes the policy engine matches on (beyond the verdict). */
export interface RequestMeta {
  /** Path component only (no query). */
  path: string;
  host?: string;
  method?: string;
}

/**
 * Three flat fields the adapter copies rather than interprets, so the unpaid
 * 402, the fail-closed 502 and a settled request's receipt all fit without a
 * second wire change out to the hand-written adapters.
 */
export interface PaymentInstruction {
  /** Answer with this instead of reaching the origin. */
  status?: number;
  headers?: Record<string, string>;
  /** Already serialized. Ignored when `status` is absent. */
  body?: string;
}

/** The decision returned to the inner worker by a PolicyClient. */
export interface ClientDecision {
  action: Enforcement;
  policyAction?: PolicyRuleAction;
  ruleId?: string;
  verdict?: Verdict;
  /** True when the decision is a fail-open fallback, not a policy evaluation. */
  failOpen?: boolean;
  payment?: PaymentInstruction;
}

/**
 * The inner worker's only dependency (design invariant #4). MVP implementation
 * is an HTTP call to the outer policy worker; the approach-2 implementation is
 * local evaluation over synced data — the worker shell doesn't change.
 */
export interface PolicyClient {
  getDecision(payload: RequestPayload): Promise<ClientDecision>;
}
