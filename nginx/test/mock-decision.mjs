// Answers /v1/decision the way the worker would, one scenario per request
// (picked by `scenario=` in the request's query), and records every decision
// payload and outcome report it receives. GET /__log reads them back.
import { createServer } from 'node:http';

const decisions = [];
const reports = [];
const PORT = Number(process.env.MOCK_PORT ?? 9010);

const verdict = { tier: 'claimed', identity: 'test-bot' };
const pass = (extra = {}) => [200, { action: 'pass', verdict, ...extra }];
const paidHeaders = {
  'payment-receipt': 'receipt-1',
  'set-cookie': '__Host-d3pay=NEWSESSION; Path=/; Secure; HttpOnly; SameSite=Lax',
  'access-control-expose-headers': 'payment-receipt',
};

const SCENARIOS = {
  pass: () => pass(),
  early: () => [200, { action: 'pass' }],
  block: () => [200, { action: 'block', ruleId: 'rule-1', verdict }],
  gate402: () =>
    pass({
      payment: {
        status: 402,
        headers: {
          'payment-required': 'eyJ4NDAyVmVyc2lvbiI6Mn0=',
          link: '<https://dna.d3.com/approve/h1>; rel="payment"',
          'access-control-expose-headers': 'payment-required, link',
          'x-bad': 'a\r\nset-cookie: evil=1',
        },
        body: '{"error":"payment_required","priceUsd":"0.001"}',
      },
    }),
  gate402html: () =>
    pass({
      payment: {
        status: 402,
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: '<p>Pay to read</p>',
      },
    }),
  redirect: () =>
    pass({
      payment: { status: 302, headers: { location: 'https://dna.d3.com/policy-worker/auth?handoff=h1' } },
    }),
  stub: () =>
    pass({
      payment: { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: '<p>copy</p>' },
    }),
  paid: () => pass({ payment: { headers: paidHeaders } }),
  paidmeta: () =>
    pass({ payment: { headers: paidHeaders, meta: { 'x402/payment-response': { success: true } } } }),
  keyarg: () => pass({ mcpKeyArgument: true }),
  keyargoff: () => pass({ mcpKeyArgument: false }),
  jsonrpc402: () =>
    pass({
      payment: {
        status: 402,
        bodyKind: 'json-rpc',
        headers: { 'payment-required': 'eyJ4fQ==' },
        body: '{"content":[{"type":"text","text":"pay first"}],"isError":true}',
      },
    }),
  slow: async () => {
    await new Promise((r) => setTimeout(r, 1200));
    return pass();
  },
  slowpay: async () => {
    await new Promise((r) => setTimeout(r, 4000));
    return pass();
  },
  error500: () => [500, { error: 'internal' }],
  unauthorized: () => [401, { error: 'unknown-key' }],
  badjson: () => [200, 'not json'],
};

createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const text = Buffer.concat(chunks).toString('utf8');
    if (req.method === 'GET' && req.url === '/__log') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ decisions, reports }));
    }

    if (req.url === '/v1/report') {
      reports.push({ auth: req.headers.authorization, report: JSON.parse(text) });
      res.writeHead(202);
      return res.end();
    }

    const payload = JSON.parse(text);
    decisions.push({ auth: req.headers.authorization, payload });
    const scenario = new URL(payload.url, 'http://x').searchParams.get('scenario') ?? 'pass';
    // A byte every 100 ms: each read beats a per-read timeout, the whole answer never does.
    if (scenario === 'trickle') {
      res.writeHead(200, { 'content-type': 'application/json' });
      const answer = JSON.stringify({ action: 'pass', verdict });
      let at = 0;
      const timer = setInterval(() => {
        if (at >= answer.length || res.destroyed) {
          clearInterval(timer);
          return res.end();
        }

        res.write(answer[at++]);
      }, 100);
      return undefined;
    }

    const [status, body] = await (SCENARIOS[scenario] ?? SCENARIOS.pass)();
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
}).listen(PORT, '127.0.0.1');
