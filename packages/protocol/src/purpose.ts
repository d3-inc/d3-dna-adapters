/**
 * Our controlled vocabulary — the words WE assert a bot is for (ADR 0001 §2).
 * "No answer" is the empty set, not a member (`unknown` is only the label
 * rendered for an empty set, never a stored value).
 */
export const PURPOSES = [
  'search',
  'training',
  'user-answer',
  'scrape',
  'transact',
  'seo',
  'report',
  'preview',
  'feed',
  'monitoring',
] as const;

export type Purpose = (typeof PURPOSES)[number];

/** Headers a request can claim purposes in (no Web Bot Auth purpose header exists yet); first present wins. */
export const PURPOSE_HEADERS = ['sec-purpose', 'x-purpose', 'purpose'] as const;
