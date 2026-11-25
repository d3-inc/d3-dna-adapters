import type { ClientDecision, NetworkFacts } from '@d3-inc/d3-dna-protocol';
import { geolocation as vercelGeolocation } from '@vercel/functions';

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

/** Vercel exposes the country and nothing of the connection; `geolocation()` reads the `x-vercel-ip-country` header. */
export function networkFactsFromVercel(request: Request): NetworkFacts | undefined {
  const country = vercelGeolocation(request).country;
  return country ? { country } : undefined;
}
