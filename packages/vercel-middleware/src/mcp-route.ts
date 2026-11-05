import {
  ADAPTER_SET,
  buildPaymentResponse,
  builtAnswerOf,
  createHttpPolicyClient,
  edgeLogger,
  extractEdgeRequest,
  McpKeyArgumentMemory,
  mcpOriginRequest,
  pathOf,
  paymentEdgeMode,
  requestPresentsPayment,
  sendReport,
  stripPaymentHeaders,
  withMcpResult,
  withPaymentHeaders,
  type BuiltAnswer,
  type ClientDecision,
  type EdgeMode,
} from '@d3-inc/d3-dna-protocol';
import { ipAddress as vercelIpAddress, waitUntil as vercelWaitUntil } from '@vercel/functions';
import { blockResponse, networkFactsFromVercel, paymentUnavailableResponse } from './answers';
import { resolveConfig, type D3MiddlewareConfig } from './env';

const log = edgeLogger('vercel-mcp');

/** Injectable seams, as `MiddlewareDeps`. */
export interface McpRouteDeps {
  fetchImpl?: typeof fetch;
  ipAddress?: (request: Request) => string | undefined;
  waitUntil?: (promise: Promise<unknown>) => void;
}

/**
 * The adapter for one MCP route: decides each call, lifts its payment out of
 * the body, calls `handler` with what is left, and puts the receipt in the
 * result. Leave this route out of the middleware's `matcher`, or a call is
 * decided twice.
 *
 *   // app/mcp/route.ts
 *   export const POST = withD3Mcp(mcpHandler);
 */
export function withD3Mcp<R extends Request, A extends unknown[]>(
  handler: (request: R, ...rest: A) => Response | Promise<Response>,
  config?: D3MiddlewareConfig,
  deps: McpRouteDeps = {}
) {
  const cfg = resolveConfig(config);
  const ipFn = deps.ipAddress ?? ((request: Request) => vercelIpAddress(request));
  const waitUntilFn = deps.waitUntil ?? ((promise: Promise<unknown>) => vercelWaitUntil(promise));
  const keyArgument = new McpKeyArgumentMemory();

  return async function d3McpRoute(request: R, ...rest: A): Promise<Response> {
    if (!cfg.endpoint) return handler(request, ...rest);

    const endpoint = cfg.endpoint;
    const host = new URL(request.url).host;
    const { payload, mcp } = await extractEdgeRequest(request, {
      ip: ipFn(request),
      network: networkFactsFromVercel(request),
      debugHeaders: cfg.debugLogRawPayload,
      adapterSet: ADAPTER_SET,
      exclude: cfg.exclude,
    });
    const requestId = crypto.randomUUID();
    payload.requestId = requestId;
    const paying = requestPresentsPayment(request) || Object.keys(mcp?.lifted ?? {}).length > 0;
    const client = createHttpPolicyClient(
      { url: endpoint, bearer: cfg.apiKey, timeoutMs: paying ? cfg.paymentTimeoutMs : cfg.timeoutMs },
      deps.fetchImpl
    );
    // The handler gets its own request type back (a `NextRequest`), not the plain one the strip builds.
    const forOrigin = (): R => {
      const stripped = stripPaymentHeaders(request);
      const same =
        stripped === request ? request : new (request.constructor as new (input: Request) => R)(stripped);
      return mcpOriginRequest(same, mcp);
    };

    const report = (
      mode: EdgeMode,
      response: Response,
      answer?: Promise<BuiltAnswer | undefined>
    ): Response => {
      waitUntilFn(
        Promise.resolve(answer).then((built) =>
          sendReport(
            {
              requestId,
              ts: Date.now(),
              host: payload.host,
              path: pathOf(payload.url),
              method: payload.method,
              mode,
              status: response.status,
              contentType: response.headers.get('content-type') ?? undefined,
              answer: built,
            },
            { url: endpoint, bearer: cfg.apiKey },
            deps.fetchImpl
          )
        )
      );
      return response;
    };

    const reportBuilt = (mode: EdgeMode, response: Response): Response =>
      report(
        mode,
        response,
        builtAnswerOf(response).catch(() => undefined)
      );

    let decision: ClientDecision;
    try {
      decision = await client.getDecision(payload);
    } catch (err) {
      log.error('policy call failed', { err, paying });
      if (paying) return reportBuilt('fail-closed', paymentUnavailableResponse());

      if (cfg.failMode === 'closed') {
        return reportBuilt('fail-closed', blockResponse({ action: 'block', failOpen: false }, 'fail-closed'));
      }

      return report('fail-open', withEdge(await handler(forOrigin(), ...rest), 'fail-open'));
    }

    if (decision.mcpKeyArgument !== undefined) keyArgument.remember(host, decision.mcpKeyArgument);

    if (decision.action === 'block') return reportBuilt('block', blockResponse(decision, 'block'));

    if (decision.payment?.status !== undefined) {
      const mode = paymentEdgeMode(decision.payment.status);
      return reportBuilt(mode, buildPaymentResponse(decision.payment, mode, mcp?.rpc?.id));
    }

    const receipted = withPaymentHeaders(
      withEdge(await handler(forOrigin(), ...rest), 'pass'),
      decision.payment
    );
    const passed = mcp?.rpc
      ? await withMcpResult(receipted, {
          method: mcp.rpc.method,
          meta: decision.payment?.meta,
          keyArgument: keyArgument.isOn(host),
        })
      : receipted;
    return report('pass', passed);
  };
}

function withEdge(response: Response, mode: string): Response {
  const out = new Response(response.body, response);
  out.headers.set('x-d3-edge', mode);
  return out;
}
