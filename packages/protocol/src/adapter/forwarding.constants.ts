import { VISITOR_ID_HEADER } from '../pay-session';

/** The first `ADAPTER_SET` that forwards every header and cookie instead of the allowlist (ADR 0081 decision 6). */
export const FORWARDS_ALL_SINCE = 2;

/** The first `ADAPTER_SET` that lifts an MCP call's payment, strips it before the origin and answers JSON-RPC. */
export const CARRIES_MCP_SINCE = 3;

/**
 * Both ends hold these, so nothing the adapter forwarded is lost at the worker:
 * past either the adapter says so (`droppedUnlisted`), and every name of that
 * kind not on the payload reads as sent but unread.
 */
export const FORWARDED_MAX_COOKIES = 256;

/** Per list: dropped headers, dropped cookies, and each exclusion list. */
export const FORWARDED_MAX_NAMES = 128;

/** SEP-2243's mirrors of the JSON-RPC method and the tool, resource or prompt it names. */
export const MCP_METHOD_HEADER = 'mcp-method';

export const MCP_NAME_HEADER = 'mcp-name';

/** What a conforming client mirrors the `dna_account_key` argument into (`x-mcp-header: "Dna-Key"`). */
export const MCP_DNA_KEY_HEADER = 'mcp-param-dna-key';

/**
 * The platform owns the first four. `authorization` and `proxy-authorization`
 * carry tokens ADR 0025 binds to, which the worker must never see, and no
 * setting opts them in. `cookie` goes by name, never whole. The mirrored DNA
 * key reaches the worker lifted into `payment-authorization`, or not at all.
 * The last four are the platform's own credentials for the site: Vercel's OIDC
 * token assumes the site's cloud roles, and Cloudflare Access's prove its user.
 */
export const NEVER_FORWARDED_HEADERS: ReadonlySet<string> = new Set([
  'connection',
  'transfer-encoding',
  'content-length',
  'host',
  'authorization',
  'proxy-authorization',
  'cookie',
  MCP_DNA_KEY_HEADER,
  // Ours to set from the cookie, never the client's to assert: a client naming a
  // stranger's visitor id would have the next redemption link it to their account.
  VISITOR_ID_HEADER,
  'x-vercel-oidc-token',
  'cf-access-jwt-assertion',
  'cf-access-client-id',
  'cf-access-client-secret',
]);
