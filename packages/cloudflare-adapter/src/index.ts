import {
  ADAPTER_SET,
  buildPaymentResponse,
  builtAnswerOf,
  configureEdgeLogging,
  createHttpPolicyClient,
  edgeLogger,
  extractPayload,
  readAdapterSettings,
  requestPresentsPayment,
  pathOf,
  paymentEdgeMode,
  sendReport,
  stripPaymentHeaders,
  withPaymentHeaders,
  type BuiltAnswer,
  type ClientDecision,
  type AdapterSettingName,
  type AdapterSettings,
  type EdgeMode,
} from '@d3-inc/d3-dna-protocol';
import type { Env } from './env';
import { handshakeFromTlsClientAuth } from './handshake';
import { networkFactsFromCf } from './network-facts';

export type { Env } from './env';

configureEdgeLogging();
const log = edgeLogger('cloudflare-adapter');

type FetchHandler<E extends Env> = NonNullable<ExportedHandler<E>['fetch']>;

type OriginFetch<E extends Env> = (request: Request, env: E, ctx: ExecutionContext) => Promise<Response>;

/**
 * Enforcement flow shared by both deployment shapes (design doc §4.3):
 * extract → PolicyClient → enforce. Stateless; only how pass-traffic
 * reaches the origin differs.
 */
function createEnforcedFetch<E extends Env>(originFetch: OriginFetch<E>): FetchHandler<E> {
  return async (request: Request, env: E, ctx: ExecutionContext): Promise<Response> => {
    const settings = readAdapterSettings((name) => envSetting(env, name));
    const policy = policyTransport(env, settings);
    if (!policy) {
      const response = await originFetch(request, env, ctx);
      return withEdgeHeader(response, 'disabled');
    }

    // Never a decision: Shopify and Vercel renew certificates over this path, and
    // a block here is a certificate that silently expires.
    if (isAcmeChallenge(request)) {
      const response = await originFetch(request, env, ctx);
      return withEdgeHeader(response, 'pass');
    }

    const client = createHttpPolicyClient(
      {
        url: policy.url,
        bearer: policy.bearer,
        // Presence of a credential is all the adapter needs to tell the two
        // budgets apart, and it never decodes one (ADR 0032 decision 1).
        timeoutMs: requestPresentsPayment(request) ? settings.paymentTimeoutMs : settings.timeoutMs,
      },
      policy.fetch
    );

    // Cloudflare-specific, so core stays platform-free: the client IP comes from
    // cf-connecting-ip, and the client certificate and connection facts from the
    // handshake this zone terminated (never from a header — see ExtractOptions).
    const cf = (request as Request<unknown, IncomingRequestCfProperties>).cf;
    const payload = await extractPayload(request, {
      ip: request.headers.get('cf-connecting-ip') ?? undefined,
      handshake: handshakeFromTlsClientAuth(cf?.tlsClientAuth),
      network: networkFactsFromCf(cf),
      debugHeaders: settings.debugLogRawPayload,
      // This adapter honours the revision: core's cookie forwarding, strip and merge all ride with it.
      adapterSet: ADAPTER_SET,
    });
    const requestId = crypto.randomUUID();
    payload.requestId = requestId;

    // Reports via waitUntil so it never delays the client.
    const reportOutcome = (
      mode: EdgeMode,
      response: Response,
      extra: { originLatencyMs?: number; answer?: Promise<BuiltAnswer | undefined> }
    ): Response => {
      const { response: counted, bodyBytes } = withBodyByteCount(response);
      ctx.waitUntil(
        Promise.all([cappedBodyBytes(bodyBytes), extra.answer]).then(([contentLength, answer]) =>
          sendReport(
            {
              requestId,
              ts: Date.now(),
              host: payload.host,
              path: pathOf(payload.url),
              method: payload.method,
              mode,
              status: response.status,
              originLatencyMs: extra.originLatencyMs,
              contentType: response.headers.get('content-type') ?? undefined,
              contentLength,
              answer,
            },
            { url: policy.url, bearer: policy.bearer },
            policy.fetch
          )
        )
      );
      return counted;
    };

    // The adapter's own answer goes into the report whole. The clone is taken here,
    // before the byte counter locks the stream; losing it loses the answer, not the report.
    const reportBuilt = (mode: EdgeMode, response: Response): Response =>
      reportOutcome(mode, response, { answer: builtAnswerOf(response).catch(() => undefined) });
    const reportProxied = (mode: EdgeMode, response: Response, originLatencyMs: number): Response =>
      reportOutcome(mode, response, { originLatencyMs });

    let decision: ClientDecision;
    // I/O unfreezes the Workers clock, so Date.now() advances across the fetch.
    const policyStart = Date.now();
    const paying = requestPresentsPayment(request);
    try {
      decision = await client.getDecision(payload);
    } catch (err) {
      log.error('policy call failed', { err, elapsedMs: Date.now() - policyStart, paying });
      // A paying request never falls open: the page is priced and the charge may
      // already have landed, so the answer is the same 502 the worker gives (ADR 0044).
      if (paying) {
        return reportBuilt('fail-closed', paymentUnavailableResponse());
      }

      // Enforcement failure must never take the site down (§8), unless opted into fail-closed.
      if (settings.failMode === 'closed') {
        return reportBuilt('fail-closed', blockResponse({ action: 'block', failOpen: false }, 'fail-closed'));
      }

      // Stripped here too: an endpoint we could not reach is no reason to hand
      // the origin a credential, or put a browser-check answer in its access log.
      const { response, originLatencyMs } = await timedOriginFetch(
        originFetch,
        stripPaymentHeaders(request),
        env,
        ctx
      );
      return reportProxied('fail-open', withEdgeHeader(response, 'fail-open'), originLatencyMs);
    }

    log.info('policy-call', { elapsedMs: Date.now() - policyStart, action: decision.action });

    if (decision.action === 'block') {
      return reportBuilt('block', blockResponse(decision, 'block'));
    }

    // The money gate fails closed where enforcement fails open. An adapter
    // predating the field ignores this and serves the content, which is the
    // cost ADR 0032 records rather than hides.
    if (decision.payment?.status !== undefined) {
      const mode = paymentEdgeMode(decision.payment.status);
      return reportBuilt(mode, buildPaymentResponse(decision.payment, mode));
    }

    // The origin sees the receipt on its response and never the credential.
    const { response, originLatencyMs } = await timedOriginFetch(
      originFetch,
      stripPaymentHeaders(request),
      env,
      ctx
    );
    // A settled payment carries its receipt onto the origin's own response.
    const passed = withPaymentHeaders(withEdgeHeader(response, 'pass'), decision.payment);
    return reportProxied('pass', passed, originLatencyMs);
  };
}

/** Standalone worker: deployed on the hostname, proxying pass-traffic to the origin. */
export default {
  fetch: createEnforcedFetch((request, env) => proxyToOrigin(request, env)),
} satisfies ExportedHandler<Env>;

/**
 * Wraps an existing Worker's handler with D3 Edge enforcement: pass-traffic
 * invokes the wrapped `fetch`, block answers 403 before it runs. The worker's
 * own env supplies the `DNA_*` config; `ORIGIN`/`ORIGIN_URL` are unused
 * since the wrapped handler is the origin. Non-fetch handlers (`scheduled`,
 * `queue`, …) pass through untouched.
 */
export function withD3Edge<E extends Env>(handler: ExportedHandler<E>): ExportedHandler<E> {
  const inner = handler.fetch;
  if (!inner) throw new Error('withD3Edge: handler has no fetch export to protect');

  return {
    ...handler,
    fetch: createEnforcedFetch<E>(async (request, env, ctx) =>
      inner.call(handler, request as Parameters<typeof inner>[0], env, ctx)
    ),
  };
}

interface PolicyTransport {
  url: string;
  bearer?: string;
  fetch: typeof fetch;
}

// A binding routes by itself and the worker reads only the path, so the host is
// a placeholder; `.invalid` keeps it from ever being taken for a public one.
const FLEET_DECISION_URL = 'https://policy-worker.invalid/v1/decision';

/**
 * Our fleet deployment holds the binding and no key, a customer's install its
 * org's key (docs/fleet-adapter.md). Neither ⇒ enforcement off.
 */
function policyTransport(env: Env, settings: AdapterSettings): PolicyTransport | null {
  const fleet = env.POLICY_WORKER;
  if (fleet) return { url: FLEET_DECISION_URL, fetch: (input, init) => fleet.fetch(input, init) };

  if (!settings.endpoint) return null;
  return { url: settings.endpoint, bearer: settings.apiKey, fetch };
}

// wrangler passes unquoted TOML vars (`DNA_ENABLED = false`) as booleans and numbers, despite `Env`.
function envSetting(env: Env, name: AdapterSettingName): string | undefined {
  const value: unknown = env[name];
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : undefined;
}

async function proxyToOrigin(request: Request, env: Env): Promise<Response> {
  if (env.ORIGIN) return env.ORIGIN.fetch(request); // origin is a Worker: service binding

  if (!env.ORIGIN_URL) return fetch(request); // routed in front of the zone: pass through
  const incoming = new URL(request.url);
  const target = new URL(env.ORIGIN_URL);
  target.pathname = incoming.pathname;
  target.search = incoming.search;
  return fetch(new Request(target.toString(), request));
}

async function timedOriginFetch<E extends Env>(
  originFetch: OriginFetch<E>,
  request: Request,
  env: E,
  ctx: ExecutionContext
): Promise<{ response: Response; originLatencyMs: number }> {
  const start = Date.now();
  const response = await originFetch(request, env, ctx);
  return { response, originLatencyMs: Date.now() - start };
}

// Cap the wait for a streamed body count: a never-ending response (SSE) or a
// stalled client would otherwise pin the waitUntil task forever. Past the cap
// we report an unknown length.
const REPORT_BYTE_COUNT_TIMEOUT_MS = 30_000;

function cappedBodyBytes(bodyBytes: Promise<number | undefined>): Promise<number | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), REPORT_BYTE_COUNT_TIMEOUT_MS);
    void bodyBytes.then((bytes) => {
      clearTimeout(timer);
      resolve(bytes);
    });
  });
}

function contentLengthOf(response: Response): number | undefined {
  const raw = response.headers.get('content-length');
  if (raw === null) return undefined;

  const bytes = Number(raw);
  return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : undefined;
}

/**
 * Body bytes for the report: Content-Length if declared, else counted from the
 * stream as it's sent (chunked responses carry no header). bodyBytes resolves
 * when the body finishes or is canceled — a canceled download reports what it sent.
 */
function withBodyByteCount(response: Response): {
  response: Response;
  bodyBytes: Promise<number | undefined>;
} {
  const declared = contentLengthOf(response);
  if (declared !== undefined || !response.body) {
    return { response, bodyBytes: Promise.resolve(declared) };
  }

  const reader = response.body.getReader();
  let bytes = 0;
  let settle!: (total: number) => void;
  const bodyBytes = new Promise<number>((resolve) => (settle = resolve));

  const counted = new ReadableStream<Uint8Array>({
    async pull(controller) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch (err) {
        // Origin stream broke mid-body: report what reached the client.
        settle(bytes);
        controller.error(err);
        return;
      }

      if (result.done) {
        controller.close();
        settle(bytes);
        return;
      }

      bytes += result.value.byteLength;
      controller.enqueue(result.value);
    },
    cancel(reason) {
      settle(bytes);
      return reader.cancel(reason);
    },
  });

  return { response: new Response(counted, response), bodyBytes };
}

function blockResponse(decision: ClientDecision, mode: string): Response {
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

function withEdgeHeader(response: Response, mode: string): Response {
  const out = new Response(response.body, response);
  out.headers.set('x-d3-edge', mode);
  return out;
}

const ACME_CHALLENGE_PREFIX = '/.well-known/acme-challenge/';

export function isAcmeChallenge(request: Request): boolean {
  return new URL(request.url).pathname.startsWith(ACME_CHALLENGE_PREFIX);
}

function paymentUnavailableResponse(): Response {
  return new Response(JSON.stringify({ error: 'payment_unavailable' }), {
    status: 502,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-d3-edge': 'fail-closed',
    },
  });
}
