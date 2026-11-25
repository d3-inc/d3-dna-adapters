/** The decision call's statement of the rate the request was drawn at; the worker counts the request `1 / rate` times. */
export const SAMPLE_RATE_HEADER = 'x-d3-sample-rate';

/**
 * Whether to send this request for a decision, at `rate`: the rate to report for a sent request, `1` for one
 * that is always sent, or `null` to skip it. A paying request is never skipped (that would serve a paid page
 * free), nor a signed one (the agents the product is about).
 */
export function drawSampleRate(request: Request, rate: number, paying: boolean): number | null {
  if (rate >= 1 || paying || isSigned(request)) return 1;

  return Math.random() < rate ? rate : null;
}

function isSigned(request: Request): boolean {
  return request.headers.has('signature') || request.headers.has('signature-input');
}
