import {
  buildPaymentResponse,
  builtAnswerOf,
  createHttpPolicyClient,
  edgeLogger,
  extractPayload,
  FORWARDS_ALL_SINCE,
  requestPresentsPayment,
  pathOf,
  paymentEdgeMode,
  sendReport,
  stripPaymentHeaders,
  withPaymentHeaders,
  type BuiltAnswer,
  type ClientDecision,
  type EdgeMode,
} from '@d3-inc/d3-dna-protocol';
import {
  ipAddress as vercelIpAddress,
  next as vercelNext,
  rewrite as vercelRewrite,
  waitUntil as vercelWaitUntil,
} from '@vercel/functions';
import { blockResponse, networkFactsFromVercel, paymentUnavailableResponse } from './answers';
import { resolveConfig, type D3MiddlewareConfig } from './env';

const log = edgeLogger('vercel-middleware');

type ContinueInit = { headers?: HeadersInit; request?: { headers?: Headers } };
type NextFn = (init?: ContinueInit) => Response;
type RewriteFn = (destination: string, init?: ContinueInit) => Response;
type IpFn = (request: Request) => string | undefined;
type WaitUntilFn = (promise: Promise<unknown>) => void;

/** Injectable seams so the middleware runs in tests without the Vercel runtime or network. */
export interface MiddlewareDeps {
  fetchImpl?: typeof fetch;
  next?: NextFn;
  rewrite?: RewriteFn;
  ipAddress?: IpFn;
  waitUntil?: WaitUntilFn;
}

/**
 * Vercel Routing Middleware enforcing D3 bot-auth: extract → policy worker →
 * `next()` (pass) or 403 (block), failing open by default. Unlike the Cloudflare
 * inner worker it sits natively in the request path: no origin forwarding, `next()`
 * continues to the site.
 */
export function createD3Middleware(config?: D3MiddlewareConfig, deps: MiddlewareDeps = {}) {
  const cfg = resolveConfig(config);
  const nextFn: NextFn = deps.next ?? ((init) => vercelNext(init));
  const rewriteFn: RewriteFn = deps.rewrite ?? ((destination, init) => vercelRewrite(destination, init));
  const ipFn: IpFn = deps.ipAddress ?? ((request) => vercelIpAddress(request));
  const waitUntilFn: WaitUntilFn = deps.waitUntil ?? ((promise) => vercelWaitUntil(promise));

  return async function d3Middleware(request: Request): Promise<Response> {
    if (!cfg.endpoint) return nextFn({ headers: { 'x-d3-edge': 'disabled' } });

    const endpoint = cfg.endpoint;
    const paying = requestPresentsPayment(request);
    // Config resolved once at construction; only the choice between its two
    // budgets is per request.
    const client = createHttpPolicyClient(
      {
        url: endpoint,
        bearer: cfg.apiKey,
        timeoutMs: paying ? cfg.paymentTimeoutMs : cfg.timeoutMs,
      },
      deps.fetchImpl
    );
    const payload = await extractPayload(request, {
      ip: ipFn(request),
      network: networkFactsFromVercel(request),
      debugHeaders: cfg.debugLogRawPayload,
      // `next()` cannot replace the body nor see the origin's answer, so the MCP carriage is
      // `withD3Mcp`'s on its own route; the forwarding is this one's.
      adapterSet: FORWARDS_ALL_SINCE,
      exclude: cfg.exclude,
    });
    const requestId = crypto.randomUUID();
    payload.requestId = requestId;

    // `next()` is a routing continuation, not a proxy: the origin response is
    // never observable, so pass/fail-open reports carry no status or size.
    const reportOutcome = (
      mode: EdgeMode,
      response: Response,
      extra: { status?: number; answer?: Promise<BuiltAnswer | undefined> } = {}
    ): Response => {
      waitUntilFn(
        Promise.resolve(extra.answer).then((answer) =>
          sendReport(
            {
              requestId,
              ts: Date.now(),
              host: payload.host,
              path: pathOf(payload.url),
              method: payload.method,
              mode,
              status: extra.status,
              answer,
            },
            { url: endpoint, bearer: cfg.apiKey },
            deps.fetchImpl
          )
        )
      );
      return response;
    };

    // The middleware's own answer goes into the report whole; losing it loses the answer, not the report.
    const reportBuilt = (mode: EdgeMode, response: Response): Response =>
      reportOutcome(mode, response, {
        status: response.status,
        answer: builtAnswerOf(response).catch(() => undefined),
      });

    let decision: ClientDecision;
    try {
      decision = await client.getDecision(payload);
    } catch (err) {
      log.error('policy call failed', { err, paying });
      // A paying request never falls open: the page is priced and the charge may
      // already have landed, so the answer is the same 502 the worker gives (ADR 0044).
      if (paying) return reportBuilt('fail-closed', paymentUnavailableResponse());

      // Enforcement failure must never take the site down (§8), unless opted into fail-closed.
      if (cfg.failMode === 'closed') {
        return reportBuilt('fail-closed', blockResponse({ action: 'block', failOpen: false }, 'fail-closed'));
      }

      // Stripped here too: an endpoint we could not reach is no reason to hand
      // the origin a credential, or put a browser-check answer in its access log.
      const clean = stripPaymentHeaders(request);
      const init = { headers: { 'x-d3-edge': 'fail-open' }, request: { headers: clean.headers } };
      return reportOutcome(
        'fail-open',
        clean.url === request.url ? nextFn(init) : rewriteFn(clean.url, init)
      );
    }

    if (decision.action === 'block') return reportBuilt('block', blockResponse(decision, 'block'));

    // Fails closed where enforcement fails open; an adapter predating the
    // field ignores it and serves the content (ADR 0032 decision 2).
    if (decision.payment?.status !== undefined) {
      const mode = paymentEdgeMode(decision.payment.status);
      return reportBuilt(mode, buildPaymentResponse(decision.payment, mode));
    }

    // Unconditional, unlike the budget above: `requestPresentsPayment` is false
    // for an oversized value, and that value must still not reach the origin.
    const clean = stripPaymentHeaders(request);
    const init = { headers: { 'x-d3-edge': 'pass' }, request: { headers: clean.headers } };
    // A redeemed handoff rides the query string, and `next()` cannot drop it: only a
    // rewrite changes the URL the site is served on.
    const continued = clean.url === request.url ? nextFn(init) : rewriteFn(clean.url, init);
    return reportOutcome('pass', withPaymentHeaders(continued, decision.payment));
  };
}
