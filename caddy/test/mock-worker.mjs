// Answers the way /v1/forward-auth would for revision 2, one scenario per
// request (picked by X-Test-Scenario), and records what each subrequest carried.
import { createServer } from 'node:http';

const seen = [];
const json = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

const SCENARIOS = {
  pass: () => [200, { 'x-d3-edge': 'pass' }, ''],
  block: () => [403, { ...json, 'x-d3-edge': 'block' }, '{"error":"blocked"}'],
  gate402: () => [
    402,
    {
      ...json,
      'x-d3-edge': 'payment-required',
      'payment-required': 'eyJ4NDAyVmVyc2lvbiI6Mn0=',
      link: '<https://dna.d3.com/approve/h1>; rel="payment"',
      'retry-after': '5',
      'access-control-expose-headers': 'payment-required, www-authenticate, link, retry-after',
    },
    '{"error":"payment_required","priceUsd":"0.001"}',
  ],
  gate402html: () => [
    402,
    {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-d3-edge': 'payment-required',
    },
    '<html><body>Pay to read</body></html>',
  ],
  stub: () => [
    200,
    {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-d3-edge': 'payment-stub',
    },
    '<p>This page costs $0.001</p>',
  ],
  redirect: () => [
    302,
    {
      'cache-control': 'no-store',
      'x-d3-edge': 'payment-redirect',
      location: 'https://dna.d3.com/policy-worker/auth?handoff=h1',
      link: '<https://dna.d3.com/approve/h1>; rel="payment"',
    },
    '',
  ],
  redeem: () => [
    302,
    {
      'cache-control': 'no-store',
      'x-d3-edge': 'payment-redirect',
      location: 'https://site.example/article',
      'set-cookie': '__Host-d3pay=NEWSESSION; Path=/; Secure; HttpOnly; SameSite=Lax',
    },
    '',
  ],
  unavailable: () => [502, { ...json, 'x-d3-edge': 'fail-closed' }, '{"error":"payment_unavailable"}'],
  paid_dna: () => [
    200,
    {
      'x-d3-edge': 'pass',
      'payment-receipt': 'eyJzdGF0dXMiOiJzdWNjZXNzIn0=',
      'access-control-expose-headers': 'payment-receipt',
      'set-cookie': '__Host-d3pay=ROTATED; Path=/; Secure; HttpOnly; SameSite=Lax',
    },
    '',
  ],
  paid_x402: () => [
    200,
    {
      'x-d3-edge': 'pass',
      'payment-response': 'eyJzdWNjZXNzIjp0cnVlfQ==',
      'access-control-expose-headers': 'payment-response',
    },
    '',
  ],
  // Not DNA's answers: what Cloudflare or a proxy in between can return.
  infra522: () => [522, { 'content-type': 'text/plain' }, 'origin unreachable'],
  infra500: () => [500, { 'content-type': 'text/plain' }, 'internal error'],
  infra429: () => [429, { 'content-type': 'text/plain' }, 'slow down'],
  // A browser-check pass: on the first page with its cookie, on the next without.
  check_passed: () => [
    200,
    {
      'x-d3-edge': 'pass',
      'cache-control': 'no-store',
      'set-cookie': '__Host-d3person=PASS; Path=/; Secure; HttpOnly; SameSite=Lax',
    },
    '',
  ],
  day_pass: () => [200, { 'x-d3-edge': 'pass', 'cache-control': 'no-store' }, ''],
  // A CDN in front of DNA adding its own caching to the answer.
  pass_cached: () => [200, { 'x-d3-edge': 'pass', 'cache-control': 'max-age=14400' }, ''],
  infra414: () => [414, { 'content-type': 'text/plain' }, 'uri too long'],
  infra431: () => [431, { 'content-type': 'text/plain' }, 'headers too large'],
  // DNA's own failure, answered the way /v1/forward-auth does today.
  worker_fail_open: () => [200, { 'x-d3-edge': 'fail-open', 'x-d3-reason': 'internal-error' }, ''],
  paid_x402_v1: () => [
    200,
    {
      'x-d3-edge': 'pass',
      'x-payment-response': 'eyJzdWNjZXNzIjp0cnVlfQ==',
      'access-control-expose-headers': 'x-payment-response',
    },
    '',
  ],
};

createServer((req, res) => {
  if (req.url === '/__log') {
    return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(seen));
  }

  if (req.url === '/__reset') {
    seen.length = 0;
    return res.writeHead(200).end('ok');
  }

  let bodyBytes = 0;
  req.on('data', (c) => {
    bodyBytes += c.length;
  });
  req.on('end', () => {
    seen.push({ method: req.method, url: req.url, headers: req.headers, bodyBytes });
    const scenario = req.headers['x-test-scenario'] ?? 'pass';
    const reply = () => {
      const [status, headers, body] = (SCENARIOS[scenario] ?? SCENARIOS.pass)();
      res.writeHead(status, headers).end(body);
    };

    const delay = Number(req.headers['x-test-delay-ms'] ?? 0);
    if (delay > 0) setTimeout(reply, delay);
    else reply();
  });
}).listen(9000, '127.0.0.1');
