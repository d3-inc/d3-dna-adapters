import { edgeLogger } from '../logging/logger';
import { DNA_ADAPTER_HEADER } from './adapter-name';
import type { BuiltAnswer, ClientDecision, PolicyClient, RequestPayload, ResponseReport } from '../types';

const log = edgeLogger('policy-client');

export interface HttpPolicyClientOptions {
  url: string;
  /** The org's adapter key, sent as `Authorization: Bearer`. The worker has no
   *  other credential — the shared secret it once fell back to is gone. Absent
   *  over a service binding, which is itself the credential. */
  bearer?: string;
  timeoutMs: number;
  /** This build's `dna-adapter` value (`adapterNameOf`); absent, the call names no build. */
  adapterName?: string;
}

const REPORT_TIMEOUT_MS = 3000;

/**
 * Two budgets: a request presenting a payment waits for it to clear, ordinary
 * traffic does not (ADR 0032 decision 1). Exported because the hot-path budget
 * was written independently in each adapter, which is two places to get the
 * second wrong. The ordinary one covers a reverse DNS lookup the worker may run
 * before answering, which it caps at 1.5 s.
 */
export const DEFAULT_POLICY_TIMEOUT_MS = 10_000;

export const DEFAULT_PAYMENT_TIMEOUT_MS = 10_000;

function jsonHeaders(bearer?: string): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  return headers;
}

/**
 * Throws on timeout/transport/HTTP errors — the caller decides fail-open vs
 * fail-closed. Platform-free: only fetch/AbortController/JSON.
 */
export function createHttpPolicyClient(
  opts: HttpPolicyClientOptions,
  fetchImpl: typeof fetch = fetch
): PolicyClient {
  return {
    async getDecision(payload: RequestPayload): Promise<ClientDecision> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
      try {
        const res = await fetchImpl(opts.url, {
          method: 'POST',
          headers: {
            ...jsonHeaders(opts.bearer),
            ...(opts.adapterName === undefined ? {} : { [DNA_ADAPTER_HEADER]: opts.adapterName }),
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        if (!res.ok) {
          // Auth failures carry an actionable reason (adapter-keys-plan D11:
          // unknown-key / expired / revoked /
          // not-configured). Log + surface it — this line in the CUSTOMER's
          // platform logs is how a dead key gets diagnosed (§9); without it,
          // fail-open makes a misconfigured key look like a working site.
          const reason = await errorReasonOf(res);
          const detail = `policy worker HTTP ${res.status}${reason ? ` (${reason})` : ''}`;
          if (res.status === 401 || res.status === 403) {
            // Over a binding there is no key to check; the reason alone is the diagnosis.
            const hint = opts.bearer ? ' — check DNA_API_KEY / key status' : '';
            log.error(`policy call rejected: ${detail}${hint}`);
          }

          throw new Error(detail);
        }

        const body = (await res.json()) as ClientDecision;
        if (body.action !== 'pass' && body.action !== 'block') {
          throw new Error('policy worker returned an invalid decision');
        }

        return body;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

async function errorReasonOf(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { error?: unknown };
    return typeof body.error === 'string' ? body.error : null;
  } catch {
    return null;
  }
}

/** Fire-and-forget report to /v1/report (resolved against the decision URL); logs errors, never throws (§8). */
/**
 * The headers and body of a response the adapter built, for `ResponseReport.answer`.
 * The clone is taken before the first await: once the client's copy is being read
 * the body is locked and can no longer be cloned, so a caller inside `waitUntil`
 * would be too late.
 */
export function builtAnswerOf(response: Response): Promise<BuiltAnswer> {
  const headers = Object.fromEntries(response.headers);
  if (response.body === null) return Promise.resolve({ headers });

  return response
    .clone()
    .text()
    .then((body) => ({ headers, body }));
}

export async function sendReport(
  report: ResponseReport,
  opts: Pick<HttpPolicyClientOptions, 'url' | 'bearer'>,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REPORT_TIMEOUT_MS);
  try {
    const res = await fetchImpl(new URL('/v1/report', opts.url).toString(), {
      method: 'POST',
      headers: jsonHeaders(opts.bearer),
      body: JSON.stringify(report),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`report endpoint HTTP ${res.status}`);
  } catch (err) {
    log.error('response report failed', { err });
  } finally {
    clearTimeout(timer);
  }
}
