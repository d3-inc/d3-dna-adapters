/**
 * DNA enforcement as a Cloudflare Snippet — the no-Worker install for zones on
 * any paid plan. This is the source; `cloudflare-snippet/snippet.js` is what a
 * customer pastes, built from here by `pnpm generate:snippet`.
 *
 * Everything shared with the npm adapters comes from packages/protocol, so the
 * forwarding caps, the credential names and the payment answer have one
 * implementation rather than a copy that drifts. What stays here is what only a
 * Snippet does: the pasted CONFIG, the sampling draw, and a body cap that fits
 * 2 MB of memory.
 *
 * Imported by module path, never from the package barrel: the barrel re-exports
 * the logger, which pulls 48 KB of logtape into a 32 KB budget.
 */
import {
  FORWARDED_HEADER_SET,
  HEADER_LENGTH_CAPS,
  forwardCookie,
  sha256ContentDigest,
} from '../../packages/protocol/src/adapter/extract';
import {
  NO_EXCLUSIONS,
  exclusionOverflowWarning,
  forwardAll,
  parseExclusionList,
  withheldOf,
  type ForwardExclusions,
} from '../../packages/protocol/src/adapter/forward-all';
import {
  blockResponse,
  paymentUnavailableResponse,
  withEdgeHeader,
} from '../../packages/protocol/src/adapter/edge-response';
import {
  buildPaymentResponse,
  paymentEdgeMode,
  withPaymentHeaders,
} from '../../packages/protocol/src/adapter/payment-response';
import {
  PAY_SESSION_COOKIE,
  PAY_SESSION_HEADER,
  PAY_SESSION_MAX_LENGTH,
  PERSON_PASS_COOKIE,
  PERSON_PASS_HEADER,
  PERSON_PASS_MAX_LENGTH,
} from '../../packages/protocol/src/pay-session';
import type { ClientDecision, RequestPayload } from '../../packages/protocol/src/types';
import { requestPresentsPayment, stripPaymentHeaders } from '../../packages/protocol/src/x402/payment-header';

export interface SnippetConfig {
  /** The org's API key, sent as `Authorization: Bearer`. Set ⇒ DNA is on, calling the default endpoint. */
  apiKey?: string;
  /** Decision endpoint override. Empty string disables enforcement: pure passthrough. */
  endpoint?: string;
  /** `false` disables enforcement without removing the key. */
  enabled?: boolean;
  /** @deprecated `endpoint`. Unlike `apiKey`, `adapterKey` needs this set to switch DNA on. */
  policyWorkerUrl?: string;
  /** @deprecated `apiKey` */
  adapterKey?: string;
  timeoutMs: number;
  paymentTimeoutMs: number;
  /** `open` passes traffic when the decision call fails. A request presenting a payment never falls open. */
  failMode: 'open' | 'closed';
  /** Fraction of requests that get a decision call. A request presenting a payment is always sampled. */
  sampleRate: number;
  alwaysSampleSigned: boolean;
  /** Comma-separated names DNA is never sent; it reads each as kept back rather than absent. */
  excludeHeaders?: string;
  excludeCookies?: string;
}

const DEFAULT_ENDPOINT = 'https://edge-api.d3.com/v1/decision';

/**
 * What this recipe does with the endpoint's answer (ADR 0068), not a version.
 * 2 forwards every header and cookie but the site's exclusions, which is what
 * carries a visitor id back to the endpoint — read the row in README.md before
 * changing it, and bump it only with the behaviour.
 */
const ADAPTER_SET = 2;

/** Our build of this file, by its own version. A copy you change sends a type of its own (PROTOCOL.md, Naming your adapter). */
const DNA_ADAPTER = 'snippet:2.0.0';

/** Snippets get 2 MB of memory, so only bodies up to this size are hashed. */
const MAX_HASHED_BODY_BYTES = 1_000_000;

/** The on switch, as in the npm adapters: an endpoint, or an API key that then calls the default one. */
export function dnaEndpoint(config: SnippetConfig): string | undefined {
  if (String(config.enabled).trim().toLowerCase() === 'false') return undefined;

  const endpoint = config.endpoint ?? config.policyWorkerUrl;
  if (endpoint !== undefined) return endpoint || undefined;

  return config.apiKey ? DEFAULT_ENDPOINT : undefined;
}

export function createSnippet(config: SnippetConfig): { fetch(request: Request): Promise<Response> } {
  // `||`, not `??`: an empty apiKey must not hide an earlier CONFIG's adapterKey.
  const apiKey = config.apiKey || config.adapterKey;
  const endpoint = dnaEndpoint(config);
  const exclude = exclusionsOf(config);
  return {
    // Unlike the Worker adapter there is no outcome report: Snippets have no
    // waitUntil, so the request is logged at decision time and nothing more.
    async fetch(request: Request): Promise<Response> {
      if (!endpoint) return withEdgeHeader(await fetch(request), 'disabled');

      const paying = requestPresentsPayment(request);
      // No Response clone and no header either: an unsampled request costs what
      // the snippet costs uninstalled. Sampling out a payment would serve a page
      // someone paid for to everyone free, so it is exempt.
      //
      // Still stripped, though: a credential or a browser-check answer must not
      // reach the origin because a draw went the other way, and the stripper
      // returns the request untouched when there is nothing on it.
      if (!paying && !isSampled(request, config)) return fetch(stripPaymentHeaders(request));

      let decision: ClientDecision;
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
            'dna-adapter': DNA_ADAPTER,
          },
          body: JSON.stringify(await extractPayload(request, exclude)),
          signal: AbortSignal.timeout(paying ? config.paymentTimeoutMs : config.timeoutMs),
        });
        if (!res.ok) throw new Error(`policy worker HTTP ${res.status}`);

        decision = (await res.json()) as ClientDecision;
        if (decision.action !== 'pass' && decision.action !== 'block') {
          throw new Error('policy worker returned an invalid decision');
        }
      } catch (err) {
        console.error('d3-edge policy call failed', err);
        // The page is priced and the charge may already have landed, so falling
        // open here would serve a paid page free.
        if (paying) return paymentUnavailableResponse();

        // Enforcement failure must never take the site down, unless opted in.
        if (config.failMode === 'closed') return blockResponse({ action: 'block' }, 'fail-closed');

        // Stripped on the way out too: an endpoint we could not reach is no
        // reason to hand the origin a credential or a check answer.
        return withEdgeHeader(await fetch(stripPaymentHeaders(request)), 'fail-open');
      }

      if (decision.action === 'block') return blockResponse(decision, 'block');

      const payment = decision.payment;
      if (payment?.status !== undefined) {
        return buildPaymentResponse(payment, paymentEdgeMode(payment.status));
      }

      const response = await fetch(stripPaymentHeaders(request));
      return withPaymentHeaders(withEdgeHeader(response, 'pass'), payment);
    },
  };
}

/** The site's kept-back names. DNA is told which, so a rule on one is skipped rather than read as absent. */
function exclusionsOf(config: SnippetConfig): ForwardExclusions {
  const headers = parseExclusionList(config.excludeHeaders, { lowercase: true });
  const cookies = parseExclusionList(config.excludeCookies, { lowercase: false });
  // Past the names the payload echoes, DNA reads every name of that kind a
  // request lacks as kept back and skips the rules that check one. The SDKs log
  // this through their logger; a Snippet has only the console.
  const overflow = exclusionOverflowWarning({ headers, cookies });
  if (overflow !== undefined) console.warn(`d3-edge: ${overflow}`);

  return headers.length === 0 && cookies.length === 0 ? NO_EXCLUSIONS : { headers, cookies };
}

function isSampled(request: Request, config: SnippetConfig): boolean {
  if (Math.random() < config.sampleRate) return true;

  return (
    config.alwaysSampleSigned && (request.headers.has('signature') || request.headers.has('signature-input'))
  );
}

/**
 * `extractPayload` from packages/protocol, but reading the body under a cap: a
 * Snippet has 2 MB of memory where a Worker has 128, and the protocol's version
 * buffers whatever arrives. Everything else it does — the caps, the forwarding,
 * what the payload says it held back — is the protocol's own code.
 */
async function extractPayload(request: Request, exclude: ForwardExclusions): Promise<RequestPayload> {
  const url = new URL(request.url);
  const forwarded = forwardAll(request.headers, exclude, HEADER_LENGTH_CAPS);
  const { headers, droppedHeaders, cookies, droppedCookies, droppedUnlisted } = forwarded;

  const cookie = request.headers.get('cookie');
  forwardCookie(headers, cookie, PAY_SESSION_COOKIE, PAY_SESSION_HEADER, PAY_SESSION_MAX_LENGTH);
  forwardCookie(headers, cookie, PERSON_PASS_COOKIE, PERSON_PASS_HEADER, PERSON_PASS_MAX_LENGTH);

  // Overwrite content-digest with the real body's digest so a tampered body
  // fails verification downstream — never forward the client's claim. A body too
  // large to hash strips the claim instead: the request then classifies as
  // unverified rather than carrying a digest nothing checked.
  const canHaveBody = request.method !== 'GET' && request.method !== 'HEAD';
  if (canHaveBody && request.body !== null) {
    const body = await readBodyUpTo(request, MAX_HASHED_BODY_BYTES);
    if (body === null) {
      // Named, not just removed: unnamed, the endpoint reads a signature over
      // `content-digest` as covering a header the agent never sent, and the
      // record blames the agent for a cap of ours. `delete` alone is true
      // whether or not the claim was there, so the presence test decides.
      if ('content-digest' in headers) {
        delete headers['content-digest'];
        droppedHeaders.push('content-digest');
      }
    } else if (body.byteLength > 0 || 'content-digest' in headers) {
      headers['content-digest'] = await sha256ContentDigest(body);
    }
  } else if ('content-digest' in headers) {
    // An empty body must not smuggle a forged digest past this.
    headers['content-digest'] = await sha256ContentDigest(new ArrayBuffer(0));
  }

  return {
    requestId: crypto.randomUUID(),
    adapterSet: ADAPTER_SET,
    headerSet: FORWARDED_HEADER_SET,
    ip: request.headers.get('cf-connecting-ip') ?? undefined,
    secure: url.protocol === 'https:',
    method: request.method,
    url: url.pathname + url.search,
    host: url.host,
    timestamp: new Date().toISOString(),
    headers,
    cookies,
    ...(droppedHeaders.length > 0 ? { droppedHeaders } : {}),
    ...(droppedCookies.length > 0 ? { droppedCookies } : {}),
    ...withheldOf(exclude, droppedUnlisted),
  };
}

/**
 * Reads a clone of the body, giving up (null) past maxBytes — Content-Length can
 * lie, so the cap is enforced on actual bytes, not the header.
 */
async function readBodyUpTo(request: Request, maxBytes: number): Promise<ArrayBuffer | null> {
  const reader = request.clone().body!.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    total += value.byteLength;
    if (total > maxBytes) {
      // Best-effort, not awaited: cancelling a cloned body's reader only settles
      // once the clone's other branch is consumed on some runtimes.
      reader.cancel().catch(() => {});
      return null;
    }

    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return body.buffer;
}

declare const CONFIG: SnippetConfig;

export default createSnippet(CONFIG);
