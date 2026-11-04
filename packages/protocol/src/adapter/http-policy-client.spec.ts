import { configure, dispose } from '@logtape/logtape';
import { createLogRecorder, type LogRecorder } from '@logtape/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientDecision, RequestPayload, ResponseReport } from '../types';
import { builtAnswerOf, createHttpPolicyClient, sendReport } from './http-policy-client';

const URL = 'https://edge-api.d3.com/v1/decision';
const PAYLOAD: RequestPayload = { method: 'GET', url: '/', host: 'ai.d3.com', headers: {} };
const REPORT: ResponseReport = {
  requestId: 'req-1',
  ts: 1_700_000_000_000,
  host: 'ai.d3.com',
  path: '/page',
  method: 'GET',
  mode: 'pass',
  status: 200,
};

function stubFetch(res: Response | 'hang'): {
  impl: typeof fetch;
  calls: { url: string; init: RequestInit }[];
} {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    if (res === 'hang') {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }

    return res;
  }) as typeof fetch;
  return { impl, calls };
}

/** Adapter-key-shaped bearer, so the spec reads like production. */
const KEY = 'd3_k_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaAAAAAA';

describe('createHttpPolicyClient', () => {
  it('returns a pass decision and attaches the adapter key as the bearer', async () => {
    const decision: ClientDecision = { action: 'pass', policyAction: 'log-only' };
    const { impl, calls } = stubFetch(Response.json(decision));
    const client = createHttpPolicyClient({ url: URL, bearer: KEY, timeoutMs: 1000 }, impl);

    expect(await client.getDecision(PAYLOAD)).toEqual(decision);
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    expect(calls[0].init.method).toBe('POST');
  });

  it('returns a block decision', async () => {
    const decision: ClientDecision = { action: 'block', policyAction: 'block', ruleId: 'r1' };
    const { impl } = stubFetch(Response.json(decision));
    const client = createHttpPolicyClient({ url: URL, timeoutMs: 1000 }, impl);
    expect(await client.getDecision(PAYLOAD)).toEqual(decision);
  });

  it('carries the payment instruction through beside the decision', async () => {
    const decision: ClientDecision = {
      action: 'pass',
      policyAction: 'log-only',
      payment: { status: 402, headers: { 'payment-required': 'eyJ4IjoxfQ==' } },
    };
    const { impl } = stubFetch(Response.json(decision));
    const client = createHttpPolicyClient({ url: URL, timeoutMs: 1000 }, impl);
    expect(await client.getDecision(PAYLOAD)).toEqual(decision);
  });

  it('omits the authorization header when no secret is configured', async () => {
    const { impl, calls } = stubFetch(Response.json({ action: 'pass' }));
    await createHttpPolicyClient({ url: URL, timeoutMs: 1000 }, impl).getDecision(PAYLOAD);
    expect((calls[0].init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it('throws on a non-2xx response', async () => {
    const { impl } = stubFetch(new Response('boom', { status: 500 }));
    const client = createHttpPolicyClient({ url: URL, timeoutMs: 1000 }, impl);
    await expect(client.getDecision(PAYLOAD)).rejects.toThrow(/HTTP 500/);
  });

  it('surfaces the auth-failure reason from the body (adapter-keys-plan §9/D11)', async () => {
    for (const [status, reason] of [
      [401, 'revoked'],
      [403, 'host-not-allowed'],
      [503, 'not-configured'],
    ] as const) {
      const { impl } = stubFetch(Response.json({ error: reason }, { status }));
      const client = createHttpPolicyClient({ url: URL, timeoutMs: 1000 }, impl);
      await expect(client.getDecision(PAYLOAD)).rejects.toThrow(new RegExp(`HTTP ${status} \\(${reason}\\)`));
    }
  });

  it('throws on an invalid decision body', async () => {
    const { impl } = stubFetch(Response.json({ action: 'self-destruct' }));
    const client = createHttpPolicyClient({ url: URL, timeoutMs: 1000 }, impl);
    await expect(client.getDecision(PAYLOAD)).rejects.toThrow(/invalid decision/);
  });

  it('aborts and throws when the call exceeds the timeout', async () => {
    vi.useFakeTimers();
    try {
      const { impl } = stubFetch('hang');
      const client = createHttpPolicyClient({ url: URL, timeoutMs: 20 }, impl);
      const p = client.getDecision(PAYLOAD);
      const assertion = expect(p).rejects.toThrow(/abort/i);
      await vi.advanceTimersByTimeAsync(25);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('builtAnswerOf', () => {
  it('copies the headers and the body, and leaves the response readable', async () => {
    const response = new Response('{"error":"payment_required"}', {
      status: 402,
      headers: { 'WWW-Authenticate': 'Payment realm="ai.d3.com"', 'cache-control': 'no-store' },
    });
    const answer = builtAnswerOf(response);
    // The client reads its copy first; the clone was taken before that.
    expect(await response.text()).toBe('{"error":"payment_required"}');
    const copied = await answer;
    expect(copied.headers).toMatchObject({
      'www-authenticate': 'Payment realm="ai.d3.com"',
      'cache-control': 'no-store',
    });
    expect(copied.body).toBe('{"error":"payment_required"}');
  });

  it('has no body for a redirect', async () => {
    const answer = await builtAnswerOf(
      new Response(null, { status: 302, headers: { location: 'https://pay.example/' } })
    );
    expect(answer).toEqual({ headers: { location: 'https://pay.example/' } });
  });
});

describe('sendReport', () => {
  it('POSTs the report to /v1/report resolved against the decision URL', async () => {
    const { impl, calls } = stubFetch(Response.json({}, { status: 202 }));
    await sendReport(REPORT, { url: URL, bearer: KEY }, impl);

    expect(calls[0].url).toBe('https://edge-api.d3.com/v1/report');
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(calls[0].init.body as string)).toEqual(REPORT);
  });

  describe('on failure it swallows the error and logs it', () => {
    let recorder: LogRecorder;

    beforeEach(async () => {
      recorder = createLogRecorder();
      await configure({
        reset: true,
        sinks: { recorder: recorder.sink },
        loggers: [
          { category: ['d3-edge'], lowestLevel: 'debug', sinks: ['recorder'] },
          { category: ['logtape', 'meta'], lowestLevel: 'warning', sinks: [] },
        ],
      });
    });

    afterEach(async () => {
      await dispose();
    });

    it('on an HTTP error', async () => {
      const { impl } = stubFetch(new Response('boom', { status: 500 }));
      await expect(sendReport(REPORT, { url: URL }, impl)).resolves.toBeUndefined();
      recorder.assertLogged({
        category: ['d3-edge', 'policy-client'],
        level: 'error',
        message: 'response report failed',
      });
    });

    it('on a transport error', async () => {
      const impl = (async () => {
        throw new TypeError('network down');
      }) as unknown as typeof fetch;
      await expect(sendReport(REPORT, { url: URL }, impl)).resolves.toBeUndefined();
      recorder.assertLogged({
        category: ['d3-edge', 'policy-client'],
        level: 'error',
        message: 'response report failed',
      });
    });
  });
});
