import type { ClientDecision } from '../types';

// The three answers every adapter builds for itself, rather than from an
// instruction the endpoint sent: the block, the money gate failing closed, and
// the tag that says which of them happened. One implementation, because a
// change to the block body in one adapter is a change agents see from some
// installs and not others.

/** The machine-readable 403. `ruleId` and the verdict are tenant-authored, so they ride the body, never a header. */
export function blockResponse(decision: ClientDecision, mode: string): Response {
  return new Response(
    JSON.stringify({
      blocked: true,
      ruleId: decision.ruleId,
      tier: decision.verdict?.tier,
      identity: decision.verdict?.identity,
    }),
    {
      status: 403,
      headers: { 'content-type': 'application/json; charset=utf-8', 'x-d3-edge': mode },
    }
  );
}

/** A priced page whose decision call failed. Never the page: the charge may already have landed. */
export function paymentUnavailableResponse(): Response {
  return new Response(JSON.stringify({ error: 'payment_unavailable' }), {
    status: 502,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-d3-edge': 'fail-closed',
    },
  });
}

/** The origin's response, tagged. Re-wrapped because a response's headers are immutable until it is. */
export function withEdgeHeader(response: Response, mode: string): Response {
  const copy = new Response(response.body, response);
  copy.headers.set('x-d3-edge', mode);
  return copy;
}
