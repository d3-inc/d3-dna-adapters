export const ANS_STATUSES = ['ACTIVE', 'DEPRECATED', 'WARNING', 'REVOKED', 'EXPIRED'] as const;

export type AnsStatus = (typeof ANS_STATUSES)[number];

/** Math.ceil(bytes / 3) * 4 — rejects oversized input on the header length, before allocating. */
export const ANS_ARTIFACT_MAX_BASE64_LENGTH = 1_398_104;

// ANS-6 §7.2 reference caps and the §7.4 freshness default; config may tighten, never widen.
export const ANS_DPOP_MAX_PROOF_BYTES = 8_192;
