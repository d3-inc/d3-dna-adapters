/**
 * The names we own on a site: cookies the endpoint sets, and the URL params
 * it rides back on. A site's own name in this space reads as ours.
 */

// The lowercase letter keeps out our apps' own cookies, `__Host-d3_acquisition`
// and `__Secure-d3-admin.*`, which no adapter should touch.
const NAMESPACE_COOKIE = /^__(?:Host|Secure)-d3[a-z]/;

const NAMESPACE_PARAM_PREFIX = 'd3pay_';

/** Ours travel outside the shared caps, so a visitor's padding can't crowd one out; this bounds how many a visitor can add. */
export const NAMESPACE_MAX_COOKIES = 8;

/** And how large each may be. Every cookie we set is a token; the longest is 96 characters. */
export const NAMESPACE_VALUE_MAX_LENGTH = 512;

/** Exact and case-sensitive: pass the name trimmed, as `readCookie` compares it. */
export function isNamespaceCookie(name: string): boolean {
  return NAMESPACE_COOKIE.test(name);
}

/** Pass the name percent-decoded, as `stripPayParams` reads it. */
export function isNamespaceParam(name: string): boolean {
  return name.startsWith(NAMESPACE_PARAM_PREFIX);
}
