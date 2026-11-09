// Drives real OpenResty (run.sh starts it) and checks what the visitor, the
// origin and DNA each saw. `node run.mjs live` with the mock DNA up, `dead` without.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';

const SITES = { include: 8120, tryFiles: 8121, legacy: 8122 };
const MOCK = 'http://127.0.0.1:9010';
const mode = process.argv[2] ?? 'live';
let failed = 0;
let passed = 0;
let seq = 0;

function check(name, ok, detail) {
  if (ok) {
    passed += 1;
  } else {
    failed += 1;
    console.log(
      `  FAIL ${name}${detail === undefined ? '' : `\n       ${JSON.stringify(detail).slice(0, 600)}`}`
    );
  }
}

function send(port, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    // Framed explicitly: node sends a GET's body without a length, which nginx then never reads.
    const framed = body === undefined ? headers : { 'content-length': Buffer.byteLength(body), ...headers };
    const req = request({ host: '127.0.0.1', port, path, method, headers: framed }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }

        resolve({ status: res.statusCode, headers: res.headers, raw: res.rawHeaders, text, json });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const tag = () => `t${++seq}${Date.now()}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function log() {
  return (await fetch(`${MOCK}/__log`)).json();
}

/** The decisions and reports for one tagged request. */
async function seen(id) {
  await sleep(150);
  const { decisions, reports } = await log();
  const mine = decisions.filter((d) => d.payload.url.includes(`t=${id}`));
  const ids = new Set(mine.map((d) => d.payload.requestId));
  return {
    decisions: mine,
    reports: reports.filter((r) => ids.has(r.report.requestId)).map((r) => r.report),
  };
}

function headerValues(res, name) {
  const out = [];
  for (let i = 0; i < res.raw.length; i += 2) if (res.raw[i].toLowerCase() === name) out.push(res.raw[i + 1]);
  return out;
}

const session = 's'.repeat(43);
const JSON_TYPE = { 'content-type': 'application/json' };
const rpc = (method, params, id = 7) => JSON.stringify({ jsonrpc: '2.0', id, method, params });

async function live() {
  // ── A pass, and what crossed to DNA ────────────────────────────────────────
  let id = tag();
  let res = await send(SITES.include, `/page?t=${id}`, {
    headers: {
      'user-agent': 'agent/1',
      'x-custom': 'c',
      'x-internal-token': 'keep-home',
      authorization: 'Bearer site-token',
      cookie: `sid=private; theme=dark; __Host-d3pay=${session}; __Host-d3person=pass1`,
    },
  });
  let s = await seen(id);
  const p = s.decisions[0]?.payload ?? {};
  check(
    'pass: the page, tagged pass',
    res.status === 200 && res.json?.origin && res.headers['x-d3-edge'] === 'pass',
    res.headers
  );
  check('pass: the marker never reaches the visitor', res.headers['x-d3-ref'] === undefined, res.headers);
  check(
    'pass: one decision, revision 3',
    s.decisions.length === 1 && p.adapterSet === 3 && p.headerSet === 2,
    s.decisions.length
  );
  check('pass: the key as a bearer', s.decisions[0]?.auth === 'Bearer test-key');
  check(
    'pass: every header but authorization and the excluded',
    p.headers?.['x-custom'] === 'c' && !p.headers?.authorization && !p.headers?.['x-internal-token'],
    p.headers
  );
  check(
    'pass: the site cookies but sid and ours',
    p.cookies?.theme === 'dark' && !p.cookies?.sid && !p.cookies?.['__Host-d3pay'],
    p.cookies
  );
  check(
    'pass: our cookies on their own headers',
    p.headers?.['d3pay-session'] === session && p.headers?.['d3pay-person'] === 'pass1',
    p.headers
  );
  check(
    'pass: the exclusions echoed',
    JSON.stringify(p.excluded?.headers) === '["x-internal-token"]' &&
      JSON.stringify(p.excluded?.cookies) === '["sid"]',
    p.excluded
  );
  check(
    'pass: the origin gets the verdict, not the credentials',
    res.json?.headers['x-d3-tier'] === 'claimed' && !/__Host-d3/.test(res.json?.headers.cookie ?? ''),
    res.json?.headers
  );
  check(
    'pass: the origin keeps the site cookies and its own bearer',
    /sid=private/.test(res.json?.headers.cookie ?? '') &&
      res.json?.headers.authorization === 'Bearer site-token'
  );
  check(
    'pass: one report, after',
    s.reports.length === 1 &&
      s.reports[0].mode === 'pass' &&
      s.reports[0].status === 200 &&
      typeof s.reports[0].originLatencyMs === 'number',
    s.reports
  );
  check(
    'pass: the report names the request',
    s.reports[0]?.path === '/page' &&
      s.reports[0]?.method === 'GET' &&
      s.reports[0]?.host === '127.0.0.1:8120',
    s.reports[0]
  );

  // ── The verdict to the upstream, only DNA's ────────────────────────────────
  res = await send(SITES.include, `/page?t=${tag()}&scenario=early`, {
    headers: { 'x-d3-tier': 'proven', 'x-d3-identity': 'forged' },
  });
  check(
    "early pass: no verdict, so no verdict headers, and never the visitor's",
    res.status === 200 &&
      res.json?.headers['x-d3-tier'] === undefined &&
      res.json?.headers['x-d3-identity'] === undefined,
    res.json?.headers
  );
  res = await send(SITES.include, `/page?t=${tag()}&scenario=error500`, {
    headers: { 'x-d3-tier': 'proven' },
  });
  check(
    "fail-open: a visitor's verdict header never reaches the upstream",
    res.json?.headers['x-d3-tier'] === undefined,
    res.json?.headers
  );
  res = await send(SITES.include, `/page?t=${tag()}`, { headers: { 'x-d3-tier': 'proven' } });
  check(
    "pass with a verdict: DNA's replaces the visitor's",
    res.json?.headers['x-d3-tier'] === 'claimed' && res.json?.headers['x-d3-identity'] === 'test-bot',
    res.json?.headers
  );

  // ── Credentials never reach the origin ─────────────────────────────────────
  id = tag();
  res = await send(SITES.include, `/page?t=${id}&d3pay_browser=abc&keep=1&d3pay_check=1`, {
    headers: {
      'payment-authorization': 'Payment k',
      'mcp-param-dna-key': 'dna_k',
      'x-payment': 'p',
      cookie: '__Host-d3person =x',
    },
  });
  const oh = res.json?.headers ?? {};
  check(
    'strip: no payment header, mirrored key or cookie of ours at the origin',
    !oh['payment-authorization'] && !oh['mcp-param-dna-key'] && !oh['x-payment'] && !oh.cookie,
    oh
  );
  check('strip: our params gone, the rest in order', res.json?.url === `/page?t=${id}&keep=1`, res.json?.url);

  // ── Block and every gate, each our own answer ──────────────────────────────
  id = tag();
  res = await send(SITES.include, `/page?t=${id}&scenario=block`);
  s = await seen(id);
  check(
    'block: a 403 with its rule',
    res.status === 403 && res.json?.ruleId === 'rule-1' && res.headers['x-d3-edge'] === 'block',
    res.text
  );
  check(
    'block: reported with the answer',
    s.reports[0]?.mode === 'block' && s.reports[0]?.answer?.body?.includes('rule-1'),
    s.reports
  );

  id = tag();
  res = await send(SITES.include, `/page?t=${id}&scenario=gate402`);
  check(
    '402: the gate as DNA sent it',
    res.status === 402 &&
      res.headers['payment-required'] &&
      res.headers.link &&
      res.json?.error === 'payment_required',
    res.headers
  );
  check(
    '402: never cached, JSON, tagged',
    res.headers['cache-control'] === 'no-store' &&
      /json/.test(res.headers['content-type']) &&
      res.headers['x-d3-edge'] === 'payment-required',
    res.headers
  );
  check(
    '402: an unsafe header dropped',
    res.headers['x-bad'] === undefined && !headerValues(res, 'set-cookie').some((v) => v.includes('evil')),
    res.headers
  );

  res = await send(SITES.include, `/page?t=${tag()}&scenario=gate402html`);
  check(
    '402: a paywall page keeps its own type',
    res.status === 402 && /text\/html/.test(res.headers['content-type']) && res.text === '<p>Pay to read</p>',
    res.headers
  );

  res = await send(SITES.include, `/page?t=${tag()}&scenario=redirect`);
  check(
    '302: a redirect with no type and no body',
    res.status === 302 &&
      res.headers.location?.includes('handoff=h1') &&
      res.headers['content-type'] === undefined &&
      res.text === '',
    { h: res.headers, t: res.text }
  );

  res = await send(SITES.include, `/page?t=${tag()}&scenario=stub`);
  check(
    'pay copy: a 200 in place of the page',
    res.status === 200 && res.text === '<p>copy</p>' && res.headers['x-d3-edge'] === 'payment-stub',
    res.text
  );

  // ── A paid page ────────────────────────────────────────────────────────────
  res = await send(SITES.include, `/page?t=${tag()}&scenario=paid`);
  const cookies = headerValues(res, 'set-cookie');
  check(
    'paid: the page with our receipt',
    res.status === 200 && res.json?.origin && res.headers['payment-receipt'] === 'receipt-1',
    res.headers
  );
  check(
    "paid: our Set-Cookie beside the site's",
    cookies.some((c) => c.startsWith('site_session=')) && cookies.some((c) => c.startsWith('__Host-d3pay=')),
    cookies
  );
  check(
    "paid: the CORS list keeps the site's and adds ours",
    headerValues(res, 'access-control-expose-headers').join(',').includes('x-site-thing') &&
      headerValues(res, 'access-control-expose-headers').join(',').includes('payment-receipt'),
    res.headers
  );
  check(
    'paid: narrowed to private, freshness kept',
    res.headers['cache-control'] === 'private, max-age=60',
    res.headers['cache-control']
  );

  res = await send(SITES.include, `/page?t=${tag()}&scenario=paid`, {
    headers: { 'x-test-origin-receipt': 'origin-own' },
  });
  check(
    'paid: our receipt replaces one the origin sent',
    JSON.stringify(headerValues(res, 'payment-receipt')) === '["receipt-1"]',
    headerValues(res, 'payment-receipt')
  );

  res = await send(SITES.include, `/page?t=${tag()}&scenario=paid`, {
    headers: { 'x-test-origin-cc': 'no-store' },
  });
  check(
    'paid: no-store stays no-store',
    res.headers['cache-control'] === 'no-store',
    res.headers['cache-control']
  );

  res = await send(SITES.include, `/page?t=${tag()}&scenario=paid`, {
    headers: { 'x-test-origin-cc': '(absent)' },
  });
  check(
    'paid: no caching from the origin is private',
    res.headers['cache-control'] === 'private',
    res.headers['cache-control']
  );

  // ── try_files to @app: one decision, and the paid page still narrowed ─────
  id = tag();
  res = await send(SITES.tryFiles, `/missing?t=${id}&scenario=paid`, {
    headers: { cookie: `__Host-d3pay=${session}` },
  });
  s = await seen(id);
  check('@app: one decision across the internal redirect', s.decisions.length === 1, s.decisions.length);
  check(
    '@app: the paid page narrowed after the redirect',
    res.status === 200 &&
      res.headers['cache-control'] === 'private, max-age=60' &&
      res.headers['payment-receipt'] === 'receipt-1',
    res.headers
  );
  check('@app: no marker leaks', res.headers['x-d3-ref'] === undefined);
  check(
    '@app: the origin sees no session',
    !/__Host-d3pay/.test(res.json?.headers.cookie ?? ''),
    res.json?.headers
  );
  check('@app: reported once', s.reports.length === 1 && s.reports[0].mode === 'pass', s.reports);

  res = await send(SITES.tryFiles, `/static.html?t=${tag()}`);
  check(
    '@app: a file nginx serves itself is still decided',
    res.status === 200 && res.text.includes('static') && res.headers['x-d3-edge'] === 'pass',
    res.headers
  );

  // ── Failing open, and closed for a payment ─────────────────────────────────
  for (const scenario of ['error500', 'badjson', 'slow', 'unauthorized']) {
    id = tag();
    res = await send(SITES.include, `/page?t=${id}&scenario=${scenario}`, {
      headers: { cookie: '__Host-d3person=pass1' },
    });
    s = await seen(id);
    check(
      `${scenario}: the page, tagged fail-open`,
      res.status === 200 && res.json?.origin && res.headers['x-d3-edge'] === 'fail-open',
      res.headers
    );
    check(
      `${scenario}: still no credential at the origin`,
      !/__Host-d3person/.test(res.json?.headers.cookie ?? ''),
      res.json?.headers
    );
    check(`${scenario}: reported as fail-open`, s.reports[0]?.mode === 'fail-open', s.reports);
  }

  const errorLog = readFileSync(process.env.ERROR_LOG, 'utf8');
  check('unauthorized: the error log says to check the key', /check DNA_API_KEY/.test(errorLog));

  res = await send(SITES.include, `/page?t=${tag()}&scenario=slow`, {
    headers: { cookie: `__Host-d3pay=${session}` },
  });
  check(
    'a paying request waits past the unpaid budget',
    res.status === 200 && res.headers['x-d3-edge'] === 'pass',
    res.headers
  );

  res = await send(SITES.include, `/page?t=${tag()}&scenario=slowpay`, {
    headers: { 'payment-signature': 'sig' },
  });
  check(
    'a paying request never falls open',
    res.status === 502 &&
      res.json?.error === 'payment_unavailable' &&
      res.headers['cache-control'] === 'no-store',
    res.text
  );

  // ── MCP ───────────────────────────────────────────────────────────────────
  id = tag();
  res = await send(SITES.include, `/mcp?t=${id}&scenario=jsonrpc402`, {
    method: 'POST',
    headers: JSON_TYPE,
    body: rpc('tools/call', { name: 'search', arguments: { q: 'a' } }),
  });
  s = await seen(id);
  check(
    'mcp: an unpaid call is answered in band with its id',
    res.status === 200 &&
      res.json?.jsonrpc === '2.0' &&
      res.json?.id === 7 &&
      res.json?.result?.isError === true,
    res.text
  );
  check(
    'mcp: tagged payment-required, never cached',
    res.headers['x-d3-edge'] === 'payment-required' && res.headers['cache-control'] === 'no-store',
    res.headers
  );
  check(
    'mcp: the call named on the payload',
    JSON.stringify(s.decisions[0]?.payload.mcp) ===
      JSON.stringify({ method: 'tools/call', source: 'body', tool: 'search' }),
    s.decisions[0]?.payload.mcp
  );

  id = tag();
  res = await send(SITES.include, `/mcp?t=${id}`, {
    method: 'POST',
    headers: JSON_TYPE,
    body: rpc('tools/call', {
      name: 'search',
      arguments: { q: 'a', n: 0.30000000000000004 },
      _meta: { 'dna.d3.com/key': 'dna_k_meta', progressToken: 3 },
    }),
  });
  s = await seen(id);
  check(
    'mcp: the key in _meta lifted onto the payload',
    s.decisions[0]?.payload.headers['payment-authorization'] === 'Payment dna_k_meta',
    s.decisions[0]?.payload.headers
  );
  check(
    'mcp: the origin gets the call without it',
    res.json?.result?.echo &&
      !JSON.stringify(res.json.result.echo).includes('dna.d3.com/key') &&
      res.json.result.echo._meta?.progressToken === 3,
    res.text
  );
  check(
    'mcp: numbers reach the origin exactly',
    res.json?.result?.echo?.arguments?.n === 0.30000000000000004,
    res.json?.result?.echo
  );

  res = await send(SITES.include, `/mcp?t=${tag()}`, {
    method: 'POST',
    headers: { ...JSON_TYPE, 'mcp-param-dna-key': 'dna_k_header' },
    body: rpc('tools/call', { name: 'search' }),
  });
  check('mcp: the mirrored key never reaches the origin', res.status === 200 && res.json?.result, res.text);

  id = tag();
  res = await send(SITES.include, `/mcp?t=${id}&scenario=paidmeta`, {
    method: 'POST',
    headers: JSON_TYPE,
    body: rpc('tools/call', { name: 'search' }),
  });
  check(
    "mcp: the receipt added to the result's _meta",
    res.json?.result?._meta?.['x402/payment-response']?.success === true && res.json?.result?.content,
    res.text
  );
  check(
    'mcp: the rewritten result loses its etag and length, and is private',
    res.headers.etag === undefined &&
      res.headers['content-length'] === undefined &&
      /^private/.test(res.headers['cache-control'] ?? ''),
    res.headers
  );

  res = await send(SITES.include, `/mcp-gzip?t=${tag()}&scenario=paidmeta`, {
    method: 'POST',
    headers: { ...JSON_TYPE, 'accept-encoding': 'gzip' },
    body: rpc('tools/call', { name: 'search' }),
  });
  check(
    'mcp: a result DNA adds to is asked for uncompressed',
    res.headers['content-encoding'] === undefined && res.json?.result?._meta?.['x402/payment-response'],
    res.headers
  );

  res = await send(SITES.include, `/mcp-gzip?t=${tag()}`, {
    method: 'POST',
    headers: { ...JSON_TYPE, 'accept-encoding': 'gzip' },
    body: rpc('tools/call', { name: 'search' }),
  });
  check(
    'mcp: a result with nothing to add keeps its compression',
    res.headers['content-encoding'] === 'gzip',
    res.headers
  );

  res = await send(SITES.include, `/mcp-sse?t=${tag()}&scenario=paidmeta`, {
    method: 'POST',
    headers: JSON_TYPE,
    body: rpc('tools/call', { name: 'search' }),
  });
  check(
    'mcp: an event stream passes untouched',
    res.text.startsWith('event: message') && !res.text.includes('payment-response'),
    res.text
  );

  await send(SITES.include, `/page?t=${tag()}&scenario=keyarg`);
  res = await send(SITES.include, `/mcp?t=${tag()}`, {
    method: 'POST',
    headers: JSON_TYPE,
    body: rpc('tools/list', {}),
  });
  check(
    'mcp: tools/list offers the key argument once the site turns it on',
    res.json?.result?.tools?.[0]?.inputSchema?.properties?.dna_account_key?.['x-mcp-header'] === 'Dna-Key',
    res.text
  );
  await send(SITES.include, `/page?t=${tag()}&scenario=keyargoff`);
  res = await send(SITES.include, `/mcp?t=${tag()}`, {
    method: 'POST',
    headers: JSON_TYPE,
    body: rpc('tools/list', {}),
  });
  check(
    'mcp: and stops when it turns it off',
    res.json?.result?.tools?.[0] && !res.json.result.tools[0].inputSchema.properties.dna_account_key,
    res.text
  );

  id = tag();
  const blob = 'x'.repeat(1_048_576);
  res = await send(SITES.include, `/mcp?t=${id}`, {
    method: 'POST',
    headers: JSON_TYPE,
    body: rpc('tools/call', { name: 'a', arguments: { blob }, _meta: { 'dna.d3.com/key': 'k' } }),
  });
  s = await seen(id);
  check(
    'mcp: a call too large to strip that names a credential is refused',
    res.status === 413 && res.headers['x-d3-edge'] === 'fail-closed' && s.decisions.length === 0,
    { status: res.status, n: s.decisions.length }
  );

  // ── The body ───────────────────────────────────────────────────────────────
  id = tag();
  const big = 'b'.repeat(64 * 1024);
  res = await send(SITES.include, `/upload?t=${id}`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: big,
  });
  s = await seen(id);
  const want = `sha-256=:${createHash('sha256').update(big).digest('base64')}:`;
  check(
    'a body spilled to disk is still digested',
    s.decisions[0]?.payload.headers['content-digest'] === want,
    s.decisions[0]?.payload.headers['content-digest']
  );
  check('and reaches the origin whole', res.json?.bodyBytes === big.length, res.json?.bodyBytes);

  // ── A location with its own header filter, and the ACME path ──────────────
  await send(SITES.include, `/own-filter/x?t=${tag()}&scenario=paid`);
  await sleep(150);
  const logged = () => readFileSync(process.env.ERROR_LOG, 'utf8');
  check(
    'a location replacing the header filter is named in the error log',
    /\/own-filter\/x runs its own header_filter_by_lua/.test(logged())
  );
  await send(SITES.include, `/own-access/x?t=${tag()}`);
  res = await send(SITES.include, `/own-access/y?t=${tag()}`);
  await sleep(150);
  check(
    'a location replacing the access phase is named in the error log',
    /\/own-access\/x runs its own access_by_lua/.test(logged()),
    res.headers
  );
  await send(SITES.include, `/mcp-own-body?t=${tag()}&scenario=paidmeta`, {
    method: 'POST',
    headers: JSON_TYPE,
    body: rpc('tools/call', { name: 'search' }),
  });
  await sleep(150);
  check(
    'a location replacing the body filter is named in the error log',
    /\/mcp-own-body runs its own body_filter_by_lua/.test(logged())
  );
  await send(SITES.include, `/own-filter/x?t=${tag()}&scenario=paid`);
  await sleep(150);
  check(
    'each is named once per path, not per request',
    (logged().match(/\/own-filter\/x runs its own/g) ?? []).length === 1
  );

  id = tag();
  res = await send(SITES.include, `/.well-known/acme-challenge/tok?t=${id}`);
  s = await seen(id);
  check(
    'an ACME challenge is never decided',
    res.status === 200 && s.decisions.length === 0 && res.headers['x-d3-edge'] === 'pass',
    s.decisions.length
  );

  // ── Found in review: each pinned here ─────────────────────────────────────
  id = tag();
  res = await send(SITES.include, `/half/x?t=${id}`, { headers: { cookie: `__Host-d3pay=${session}` } });
  s = await seen(id);
  check(
    'upgraded halfway: one decision across the old line and the include',
    s.decisions.length === 1 && res.status === 200,
    s.decisions.length
  );

  for (const path of [
    '/.well-known/acme-challenge/../../page',
    '/.well-known/acme-challenge/%2e%2e/%2E%2E/page',
  ]) {
    id = tag();
    res = await send(SITES.include, `${path}?t=${id}&scenario=block`);
    s = await seen(id);
    check(
      `ACME: ${path} is decided as the page it resolves to`,
      res.status === 403 && s.decisions.length === 1,
      { status: res.status, n: s.decisions.length }
    );
  }

  res = await send(SITES.include, `/.well-known/acme-challenge/tok?t=${tag()}`, {
    headers: { 'x-d3-tier': 'proven', 'payment-authorization': 'Payment k' },
  });
  check(
    'ACME: a real challenge passes undecided, and still without a forged verdict or a credential',
    res.json?.headers['x-d3-tier'] === undefined && res.json?.headers['payment-authorization'] === undefined,
    res.json?.headers
  );

  res = await send(SITES.include, `/page?t=${tag()}&scenario=early`, {
    headers: { X_D3_Tier: 'proven', X_D3_Identity: 'googlebot' },
  });
  check(
    'a verdict header spelled with underscores never reaches the upstream',
    res.json?.headers.x_d3_tier === undefined && res.json?.headers.x_d3_identity === undefined,
    res.json?.headers
  );

  res = await send(SITES.include, `/mcp?t=${tag()}`, {
    method: 'POST',
    headers: JSON_TYPE,
    body: '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"a","arguments":{"t":"cut \\ud83d here","dna_account_key":"k"}}}',
  });
  check(
    'a call cjson cannot read that names a credential is refused as unreadable, not passed on',
    res.status === 400 &&
      res.json?.error === 'mcp_call_unreadable' &&
      res.headers['x-d3-edge'] === 'fail-closed',
    res.status
  );

  for (const [label, type, body] of [
    [
      'a batch',
      'application/json',
      JSON.stringify([
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'a', _meta: { 'dna.d3.com/key': 'k' } },
        },
      ]),
    ],
    [
      'a call sent as text/plain',
      'text/plain',
      rpc('tools/call', { name: 'a', arguments: { dna_account_key: 'k' } }),
    ],
  ]) {
    id = tag();
    res = await send(SITES.include, `/mcp?t=${id}`, {
      method: 'POST',
      headers: { 'content-type': type },
      body,
    });
    s = await seen(id);
    check(
      `${label} naming a credential is refused, before deciding or reaching the origin`,
      res.status === 400 && res.json?.error === 'mcp_call_unreadable' && s.decisions.length === 0,
      { status: res.status, n: s.decisions.length }
    );
  }

  id = tag();
  res = await send(SITES.include, `/mcp?t=${id}`, {
    method: 'GET',
    headers: JSON_TYPE,
    body: rpc('tools/call', { name: 'a', arguments: { dna_account_key: 'k' } }),
  });
  const getSeen = await seen(id);
  check(
    'a GET carrying a call that names a credential is refused too, since nginx passes its body on',
    res.status === 400 && getSeen.decisions.length === 0,
    { status: res.status, text: res.text, n: getSeen.decisions.length }
  );

  const example = rpc('tools/call', { name: 'a', _meta: { 'dna.d3.com/key': 'k' } });
  for (const [label, type, body] of [
    [
      'a multipart upload holding an example call',
      'multipart/form-data; boundary=b',
      `--b\r\ncontent-disposition: form-data; name="f"; filename="call.json"\r\ncontent-type: application/json\r\n\r\n${example}\r\n--b--\r\n`,
    ],
    [
      'a markdown page holding an example call',
      'text/markdown',
      `# Paying over MCP\n\n\`\`\`json\n${example}\n\`\`\`\n`,
    ],
    [
      'a 2 MB upload holding an example call, from disk',
      'multipart/form-data; boundary=b',
      `--b\r\n\r\n${'x'.repeat(2_000_000)}${example}\r\n--b--\r\n`,
    ],
  ]) {
    res = await send(SITES.include, `/upload?t=${tag()}`, {
      method: 'POST',
      headers: { 'content-type': type },
      body,
    });
    check(`${label} reaches the origin`, res.status === 200 && res.json?.origin, res.status);
  }

  const quotes = '['.concat('"'.repeat(20_000_000));
  const began = Date.now();
  res = await send(SITES.include, `/upload?t=${tag()}`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: quotes,
  });
  const searched = Date.now() - began;
  check(
    'a 20 MB body of quotes is searched and passed on in well under a second',
    res.status === 200 && searched < 1500,
    {
      status: res.status,
      searched,
    }
  );

  res = await send(SITES.include, `/page?t=${tag()}`, {
    method: 'POST',
    headers: JSON_TYPE,
    body: JSON.stringify({ title: 'Paying over MCP', sample: { _meta: { 'x402/payment': {} } } }),
  });
  check(
    'a post that names a key but is no JSON-RPC call reaches the origin',
    res.status === 200 && res.json?.origin,
    res.status
  );

  const started = Date.now();
  res = await send(SITES.include, `/page?t=${tag()}&scenario=trickle`);
  const took = Date.now() - started;
  check(
    'a decision trickled a byte at a time is cut off at the budget',
    res.headers['x-d3-edge'] === 'fail-open' && took < 1500,
    { took, edge: res.headers['x-d3-edge'] }
  );

  // ── The install from before the include ───────────────────────────────────
  id = tag();
  res = await send(SITES.legacy, `/page?t=${id}`, { headers: { 'x-custom': 'c', cookie: 'theme=dark' } });
  s = await seen(id);
  const lp = s.decisions[0]?.payload ?? {};
  check(
    'legacy: revision 1, the fixed list, no cookies',
    lp.adapterSet === 1 && lp.headers && !lp.headers['x-custom'] && lp.cookies === undefined,
    lp
  );
  check(
    'legacy: the page, no marker, no report',
    res.status === 200 && res.headers['x-d3-ref'] === undefined && s.reports.length === 0,
    res.headers
  );
  res = await send(SITES.legacy, `/mcp?t=${tag()}`, {
    method: 'POST',
    headers: JSON_TYPE,
    body: rpc('tools/call', { name: 'a', _meta: { 'dna.d3.com/key': 'k' } }),
  });
  check(
    'legacy: an MCP call is not read',
    res.json?.result?.echo?._meta?.['dna.d3.com/key'] === 'k',
    res.text
  );
}

async function disabled() {
  const res = await send(
    SITES.include,
    `/page?t=${tag()}&d3pay_handoff=${'A'.repeat(22)}.${'b'.repeat(43)}&keep=1`,
    {
      headers: {
        'x-d3-tier': 'proven',
        X_D3_Identity: 'googlebot',
        'payment-authorization': 'Payment k',
        cookie: `__Host-d3pay=${session}; site=1`,
      },
    }
  );
  const h = res.json?.headers ?? {};
  check(
    'disabled: the page, tagged disabled',
    res.status === 200 && res.headers['x-d3-edge'] === 'disabled',
    res.headers
  );
  check(
    'disabled: still no forged verdict or credential at the origin',
    !h['x-d3-tier'] && !h.x_d3_identity && !h['payment-authorization'] && h.cookie === 'site=1',
    h
  );
  check(
    'disabled: our params gone',
    !res.json?.url.includes('d3pay_handoff') && res.json?.url.includes('keep=1'),
    res.json?.url
  );
  await send(SITES.include, `/page?t=${tag()}`);
  const warned =
    readFileSync(process.env.ERROR_LOG, 'utf8').match(/DNA_EXCLUDE_HEADERS lists 130 names/g) ?? [];
  check(
    'an exclusion list past 128 is warned about once per worker, not per request',
    warned.length === 1,
    warned.length
  );
}

async function dead() {
  const before = (readFileSync(process.env.ERROR_LOG, 'utf8').match(/decision call failed/g) ?? []).length;
  for (let i = 0; i < 20; i++) await send(SITES.include, `/page?t=${tag()}`);
  await sleep(200);
  const after = (readFileSync(process.env.ERROR_LOG, 'utf8').match(/decision call failed/g) ?? []).length;
  check('dead: twenty failed calls log one line, not twenty', after - before <= 1, after - before);

  let res = await send(SITES.include, `/page?t=${tag()}`, { headers: { cookie: '__Host-d3person=p' } });
  check(
    'dead: an unpaid request is served',
    res.status === 200 && res.json?.origin && res.headers['x-d3-edge'] === 'fail-open',
    res.headers
  );
  res = await send(SITES.include, `/page?t=${tag()}`, { headers: { cookie: `__Host-d3pay=${session}` } });
  check(
    'dead: a paying one is a 502',
    res.status === 502 && res.json?.error === 'payment_unavailable',
    res.text
  );
  res = await send(SITES.tryFiles, `/missing?t=${tag()}`);
  check('dead: @app is served too', res.status === 200 && res.json?.origin, res.headers);
}

await (mode === 'dead' ? dead() : mode === 'disabled' ? disabled() : live());
console.log(`${mode}: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
