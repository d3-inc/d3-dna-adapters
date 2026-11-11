import type { EdgeMode, PaymentInstruction } from '../types';

// The adapter copies a status, some headers and a string; it never learns a
// facilitator exists nor the protocol's header name. That is what lets the
// 402, the 502 and a settled request's receipt share one field (ADR 0032 D2).

/** Same rule as `headerSafeRuleId`, and the same reason. */
const HEADER_SAFE_VALUE = /^[\x20-\x7e]{1,8192}$/;

const HEADER_SAFE_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;

/**
 * Re-checked even though the worker validated: these values are provider and
 * tenant authored, and the adapter is the last place before a `Headers`
 * object. Dropped rather than escaped, since none of it is worth a 500.
 */
export function headerSafePaymentHeaders(
  headers: Record<string, string> | undefined
): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (HEADER_SAFE_NAME.test(name) && HEADER_SAFE_VALUE.test(value)) safe[name] = value;
  }

  return safe;
}

function isRedirect(status: number): boolean {
  return status >= 300 && status <= 399;
}

/** What the request log says happened; anything but a 402, a redirect or a stub's 200 is the money gate failing closed. */
export function paymentEdgeMode(status: number): EdgeMode {
  if (status === 402) return 'payment-required';

  if (isRedirect(status)) return 'payment-redirect';

  // A pay-copy `stub` rule: the words were served in place of the page, and nothing was charged.
  if (status === 200) return 'payment-stub';

  return 'fail-closed';
}

/**
 * Only for an instruction that HAS a status; without one, see `withPaymentHeaders`.
 * `rpcId` is the call's id, for a `json-rpc` instruction a revision 3 adapter answers;
 * undefined when the adapter read no call.
 */
export function buildPaymentResponse(
  payment: PaymentInstruction,
  edgeMode: string,
  rpcId?: string | number | null
): Response {
  // Without a call to answer (a notification, a batch, a body the adapter could not read) it is the plain answer.
  if (payment.bodyKind === 'json-rpc' && rpcId !== undefined) {
    return jsonRpcResponse(payment, edgeMode, rpcId);
  }

  const status = payment.status ?? 502;
  return new Response(payment.body ?? null, {
    status,
    headers: {
      // A redirect carries no body, and a JSON type on it misleads the client that follows it.
      ...(isRedirect(status) ? {} : { 'content-type': 'application/json; charset=utf-8' }),
      'cache-control': 'no-store',
      ...headerSafePaymentHeaders(payment.headers),
      'x-d3-edge': edgeMode,
    },
  });
}

/**
 * The MCP binding answers in band: a 200 carrying the result, whatever status
 * the instruction names. A result that is not JSON is the money gate failing
 * closed, as any instruction the adapter cannot render is.
 */
function jsonRpcResponse(
  payment: PaymentInstruction,
  edgeMode: string,
  id: string | number | null
): Response {
  let result: unknown;
  try {
    result = JSON.parse(payment.body ?? '');
  } catch {
    return buildPaymentResponse(
      { status: 502, body: JSON.stringify({ error: 'payment_unavailable' }) },
      'fail-closed'
    );
  }

  return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headerSafePaymentHeaders(payment.headers),
      'x-d3-edge': edgeMode,
    },
  });
}

/**
 * Listed, not inferred from the name: `set` is right for the receipt, which
 * replaces any older one, and wrong for a header the origin also authored.
 * Overwriting the origin's CORS list would revoke a browser's access to headers
 * it deliberately exposed, and overwriting its `Set-Cookie` would log a visitor
 * out of the site to hand them ours.
 */
const MERGED_HEADERS: ReadonlySet<string> = new Set(['access-control-expose-headers', 'set-cookie']);

/** The receipt carries the payer's balance and a redemption's `Set-Cookie` a session: no shared cache may hold either. */
export function privateCacheControl(origin: string | null): string {
  const directives = (origin ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (directives.length === 0) return 'private';

  // Only a bare `private` keeps a shared cache out: `private="set-cookie"` lets it store the page.
  const lowered = directives.map((directive) => directive.toLowerCase());
  if (lowered.includes('private') || lowered.includes('no-store')) return directives.join(', ');

  const shared = lowered.indexOf('public');
  if (shared === -1) return ['private', ...directives].join(', ');

  directives[shared] = 'private';
  return directives.join(', ');
}

export function withPaymentHeaders(response: Response, payment: PaymentInstruction | undefined): Response {
  const safe = headerSafePaymentHeaders(payment?.headers);
  if (Object.keys(safe).length === 0) return response;

  // The origin's headers are immutable until the response is re-wrapped.
  const copy = new Response(response.body, response);
  for (const [name, value] of Object.entries(safe)) {
    if (MERGED_HEADERS.has(name.toLowerCase()) && copy.headers.has(name)) copy.headers.append(name, value);
    else copy.headers.set(name, value);
  }

  copy.headers.set('cache-control', privateCacheControl(copy.headers.get('cache-control')));
  return copy;
}
