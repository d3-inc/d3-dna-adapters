// Drives real WordPress (run.sh starts it) and checks what the visitor,
// WordPress and DNA each saw. `node run.mjs <phase>`, one per install run.sh starts.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { request } from 'node:http';

// PHP-FPM can end a response before PHP finishes, so only it reports.
const SITES = {
  fpm: { port: 8130, reports: true },
  apache: { port: 8131, reports: false },
  php74: { port: 8132, reports: false },
};
const MOCK = 'http://127.0.0.1:9020';
const MCP = '/wp-json/dna-test/v1/mcp';
const phase = process.argv[2] ?? 'live';
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

/** The decisions and reports for one tagged request. */
async function seen(id, wait = 300) {
  await sleep(wait);
  const { decisions, reports } = await (await fetch(`${MOCK}/__log`)).json();
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

const phpLog = () =>
  execFileSync('docker', ['compose', '-f', 'compose.yml', 'logs', '--no-log-prefix', 'fpm'], {
    encoding: 'utf8',
  });

const session = 's'.repeat(43);
const digestOf = (body) => `sha-256=:${createHash('sha256').update(body).digest('base64')}:`;
const JSON_TYPE = { 'content-type': 'application/json' };
const rpc = (method, params, id = 7) => JSON.stringify({ jsonrpc: '2.0', id, method, params });

/** Everything every server does, whatever runs PHP. */
async function core(label, { port, reports }) {
  // ── A pass, and what crossed to DNA ────────────────────────────────────────
  let id = tag();
  let res = await send(port, `/page?t=${id}`, {
    headers: {
      'user-agent': 'agent/1',
      'x-custom': 'c',
      'x-internal-token': 'keep-home',
      authorization: 'Bearer site-token',
      cookie: `sid=private; theme=dark; __Host-d3pay=${session}; __Host-d3person=pass1`,
      'dna-adapter': 'caddy:9.9.9',
    },
  });
  let s = await seen(id);
  const p = s.decisions[0]?.payload ?? {};
  check(
    `${label}: pass: the page, tagged pass`,
    res.status === 200 && res.json?.origin && res.headers['x-d3-edge'] === 'pass',
    res.headers
  );
  check(`${label}: pass: run from wp-config.php`, res.json?.entry === 'wp-config', res.json?.entry);
  check(
    `${label}: pass: one decision, revision 4`,
    s.decisions.length === 1 && p.adapterSet === 4 && p.headerSet === 2,
    s.decisions.length
  );
  check(`${label}: pass: the key as a bearer`, s.decisions[0]?.auth === 'Bearer test-key');
  check(
    `${label}: pass: names this plugin, never the visitor's dna-adapter`,
    s.decisions[0]?.adapter === 'wordpress:1.1.0',
    s.decisions[0]?.adapter
  );
  check(
    `${label}: pass: every header but authorization and the excluded`,
    p.headers?.['x-custom'] === 'c' &&
      p.headers?.['user-agent'] === 'agent/1' &&
      !p.headers?.authorization &&
      !p.headers?.['x-internal-token'],
    p.headers
  );
  check(
    `${label}: pass: the site cookies but sid and ours`,
    p.cookies?.theme === 'dark' && !p.cookies?.sid && !p.cookies?.['__Host-d3pay'],
    p.cookies
  );
  check(
    `${label}: pass: our cookies on their own headers`,
    p.headers?.['d3pay-session'] === session && p.headers?.['d3pay-person'] === 'pass1',
    p.headers
  );
  check(
    `${label}: pass: the exclusions echoed`,
    JSON.stringify(p.excluded?.headers) === '["x-internal-token"]' &&
      JSON.stringify(p.excluded?.cookies) === '["sid"]',
    p.excluded
  );
  check(
    `${label}: pass: the request named as the agent sent it`,
    p.url === `/page?t=${id}` &&
      p.host === `127.0.0.1:${port}` &&
      p.method === 'GET' &&
      typeof p.ip === 'string',
    p
  );
  check(
    `${label}: pass: WordPress gets the verdict, not the credentials`,
    res.json?.headers['x-d3-tier'] === 'claimed' &&
      !/__Host-d3/.test(res.json?.headers.cookie ?? '') &&
      !res.json?.cookies['__Host-d3pay'],
    res.json?.headers
  );
  check(
    `${label}: pass: WordPress keeps the site cookies`,
    res.json?.cookies.sid === 'private' &&
      res.json?.cookies.theme === 'dark' &&
      /sid=private/.test(res.json?.headers.cookie ?? ''),
    res.json?.cookies
  );
  if (reports) {
    check(
      `${label}: pass: one report, after`,
      s.reports.length === 1 &&
        s.reports[0].mode === 'pass' &&
        s.reports[0].status === 200 &&
        typeof s.reports[0].originLatencyMs === 'number',
      s.reports
    );
    check(
      `${label}: pass: the report names the request`,
      s.reports[0]?.path === '/page' &&
        s.reports[0]?.method === 'GET' &&
        s.reports[0]?.host === `127.0.0.1:${port}` &&
        /json/.test(s.reports[0]?.contentType),
      s.reports[0]
    );
  } else {
    check(
      `${label}: pass: nothing reported where PHP cannot end the response first`,
      s.reports.length === 0,
      s.reports
    );
  }

  // ── The verdict to WordPress, only DNA's ───────────────────────────────────
  res = await send(port, `/page?t=${tag()}&scenario=early`, {
    headers: { 'x-d3-tier': 'proven', 'x-d3-identity': 'forged' },
  });
  check(
    `${label}: early pass: no verdict, so no verdict headers, and never the visitor's`,
    res.status === 200 &&
      res.headers['x-d3-edge'] === 'pass' &&
      res.json?.headers['x-d3-tier'] === undefined &&
      res.json?.headers['x-d3-identity'] === undefined,
    { edge: res.headers['x-d3-edge'], origin: res.json?.headers }
  );
  res = await send(port, `/page?t=${tag()}&scenario=error500`, { headers: { 'x-d3-tier': 'proven' } });
  check(
    `${label}: fail-open: a visitor's verdict header never reaches WordPress`,
    res.json?.headers['x-d3-tier'] === undefined,
    res.json?.headers
  );
  res = await send(port, `/page?t=${tag()}`, { headers: { 'x-d3-tier': 'proven' } });
  check(
    `${label}: pass with a verdict: DNA's replaces the visitor's`,
    res.json?.headers['x-d3-tier'] === 'claimed',
    res.json?.headers
  );

  // ── Ours beyond the credentials: to DNA in the cookie map, never to WordPress ─
  for (const name of ['__Host-d3visitor', '__Secure-d3visitor']) {
    for (const scenario of ['pass', 'error500']) {
      id = tag();
      res = await send(port, `/page?t=${id}&scenario=${scenario}`, {
        headers: { cookie: `${name}=V1; site=1` },
      });
      s = await seen(id);
      check(
        `${label}: ours: ${name} alone reaches DNA on ${scenario}, and never WordPress`,
        s.decisions[0]?.payload.cookies?.[name] === 'V1' &&
          res.json?.origin &&
          res.json.headers.cookie === 'site=1' &&
          Object.keys(res.json?.cookies ?? {}).join() === 'site',
        { dna: s.decisions[0]?.payload.cookies, origin: res.json?.cookies }
      );
    }
  }

  // ── Credentials never reach WordPress ──────────────────────────────────────
  id = tag();
  res = await send(port, `/page?t=${id}&d3pay_browser=abc&keep=1&d3pay_check=1&d3pay.handoff=x`, {
    headers: {
      'payment-authorization': 'Payment k',
      'payment-signature': 'sig',
      'mcp-param-dna-key': 'dna_k',
      'x-payment': 'p',
      'd3pay-session': 'forged-session',
      'd3pay-person': 'forged-person',
      cookie: '__Host-d3person =x',
    },
  });
  const oh = res.json?.headers ?? {};
  check(
    `${label}: strip: no payment header, mirrored key or cookie of ours at WordPress`,
    res.json?.origin &&
      [
        'payment-authorization',
        'payment-signature',
        'mcp-param-dna-key',
        'x-payment',
        'd3pay-session',
        'd3pay-person',
        'cookie',
      ].every((name) => oh[name] === undefined) &&
      Object.keys(res.json.cookies).length === 0,
    { oh, cookies: res.json?.cookies }
  );
  check(
    `${label}: strip: our params gone from the URI, the rest in order`,
    res.json?.url === `/page?t=${id}&keep=1&d3pay.handoff=x` &&
      res.json?.query === `t=${id}&keep=1&d3pay.handoff=x`,
    res.json?.url
  );
  check(
    `${label}: strip: nor in the copies PHP keeps beside them`,
    !JSON.stringify([res.json?.argv, res.json?.redirectQuery, res.json?.env]).match(/d3pay_|__Host-d3|"p"/),
    { argv: res.json?.argv, redirect: res.json?.redirectQuery, env: res.json?.env }
  );
  check(
    `${label}: strip: and from $_GET and $_REQUEST, whatever PHP named them`,
    Object.keys(res.json?.get ?? {}).join() === 't,keep' &&
      Object.keys(res.json?.request ?? {}).join() === 't,keep',
    { get: res.json?.get, request: res.json?.request }
  );

  // ── Block and every gate, each our own answer ──────────────────────────────
  id = tag();
  res = await send(port, `/page?t=${id}&scenario=block`);
  s = await seen(id);
  check(
    `${label}: block: a 403 with its rule`,
    res.status === 403 &&
      res.json?.ruleId === 'rule-1' &&
      res.json?.blocked === true &&
      res.headers['x-d3-edge'] === 'block',
    res.text
  );
  check(
    `${label}: block: WordPress never ran`,
    headerValues(res, 'set-cookie').length === 0 && !res.json?.origin,
    res.headers
  );
  if (reports) {
    check(
      `${label}: block: reported with the answer`,
      s.reports[0]?.mode === 'block' &&
        s.reports[0]?.status === 403 &&
        s.reports[0]?.answer?.body?.includes('rule-1'),
      s.reports
    );
  }

  res = await send(port, `/page?t=${tag()}&scenario=gate402`);
  check(
    `${label}: 402: the gate as DNA sent it`,
    res.status === 402 &&
      res.headers['payment-required'] &&
      res.headers.link &&
      res.json?.error === 'payment_required',
    res.headers
  );
  check(
    `${label}: 402: never cached, JSON, tagged`,
    res.headers['cache-control'] === 'no-store' &&
      /json/.test(res.headers['content-type']) &&
      res.headers['x-d3-edge'] === 'payment-required',
    res.headers
  );
  check(
    `${label}: 402: an unsafe header dropped`,
    res.headers['x-bad'] === undefined && !headerValues(res, 'set-cookie').some((v) => v.includes('evil')),
    res.headers
  );

  res = await send(port, `/page?t=${tag()}&scenario=gate402html`);
  check(
    `${label}: 402: a paywall page keeps its own type`,
    res.status === 402 && /text\/html/.test(res.headers['content-type']) && res.text === '<p>Pay to read</p>',
    res.headers
  );

  res = await send(port, `/page?t=${tag()}&scenario=redirect`);
  check(
    `${label}: 302: a redirect with no type and no body`,
    res.status === 302 &&
      res.headers.location?.includes('handoff=h1') &&
      res.headers['content-type'] === undefined &&
      res.text === '',
    { h: res.headers, t: res.text }
  );

  res = await send(port, `/page?t=${tag()}&scenario=stub`);
  check(
    `${label}: pay copy: a 200 in place of the page`,
    res.status === 200 && res.text === '<p>copy</p>' && res.headers['x-d3-edge'] === 'payment-stub',
    res.text
  );

  // ── A paid page ────────────────────────────────────────────────────────────
  res = await send(port, `/page?t=${tag()}&scenario=paid`);
  const cookies = headerValues(res, 'set-cookie');
  check(
    `${label}: paid: the page with our receipt`,
    res.status === 200 && res.json?.origin && res.headers['payment-receipt'] === 'receipt-1',
    res.headers
  );
  check(
    `${label}: paid: our Set-Cookie beside the site's`,
    cookies.some((c) => c.startsWith('site_session=')) &&
      cookies.some((c) => c.startsWith('__Host-d3pay=NEWSESSION')),
    cookies
  );
  const exposed = headerValues(res, 'access-control-expose-headers').join(',');
  check(
    `${label}: paid: the CORS list keeps the site's and adds ours`,
    exposed.includes('x-site-thing') && exposed.includes('payment-receipt'),
    exposed
  );
  check(
    `${label}: paid: narrowed to private, freshness kept`,
    res.headers['cache-control'] === 'private, max-age=60',
    res.headers['cache-control']
  );

  res = await send(port, `/page?t=${tag()}&scenario=paid`, {
    headers: { 'x-test-origin-receipt': 'origin-own' },
  });
  check(
    `${label}: paid: our receipt replaces one WordPress sent`,
    JSON.stringify(headerValues(res, 'payment-receipt')) === '["receipt-1"]',
    headerValues(res, 'payment-receipt')
  );
  res = await send(port, `/page?t=${tag()}&scenario=paid`, { headers: { 'x-test-origin-cc': 'no-store' } });
  check(
    `${label}: paid: no-store stays no-store`,
    res.headers['cache-control'] === 'no-store',
    res.headers['cache-control']
  );
  res = await send(port, `/page?t=${tag()}&scenario=paid`, { headers: { 'x-test-origin-cc': '(absent)' } });
  check(
    `${label}: paid: no caching from WordPress is private`,
    /^private/.test(res.headers['cache-control'] ?? ''),
    res.headers['cache-control']
  );
  res = await send(port, `/page?t=${tag()}&scenario=pass`, {
    headers: { 'x-test-origin-cc': 'public, max-age=60' },
  });
  check(
    `${label}: unpaid: WordPress's caching untouched`,
    res.headers['cache-control'] === 'public, max-age=60',
    res.headers['cache-control']
  );

  // ── Failing open, and closed for a payment ─────────────────────────────────
  for (const scenario of ['error500', 'badjson', 'slow', 'trickle', 'unauthorized']) {
    id = tag();
    const started = Date.now();
    res = await send(port, `/page?t=${id}&scenario=${scenario}`, {
      headers: { cookie: '__Host-d3person=pass1' },
    });
    const took = Date.now() - started;
    s = await seen(id);
    check(
      `${label}: ${scenario}: the page, tagged fail-open`,
      res.status === 200 && res.json?.origin && res.headers['x-d3-edge'] === 'fail-open',
      res.headers
    );
    check(`${label}: ${scenario}: within the budget`, took < 2000, took);
    check(
      `${label}: ${scenario}: still no credential at WordPress`,
      !/__Host-d3person/.test(res.json?.headers.cookie ?? ''),
      res.json?.headers
    );
    if (reports && ['slow', 'trickle'].includes(scenario)) {
      // An endpoint that did not answer in time is not kept waiting on for a report too.
      check(`${label}: ${scenario}: not reported`, s.reports.length === 0, s.reports);
    } else if (reports) {
      check(`${label}: ${scenario}: reported as fail-open`, s.reports[0]?.mode === 'fail-open', s.reports);
    }
  }

  res = await send(port, `/page?t=${tag()}&scenario=slow`, {
    headers: { cookie: `__Host-d3pay=${session}` },
  });
  check(
    `${label}: a paying request waits past the unpaid budget`,
    res.status === 200 && res.headers['x-d3-edge'] === 'pass',
    res.headers
  );
  res = await send(port, `/page?t=${tag()}&scenario=slowpay`, { headers: { 'payment-signature': 'sig' } });
  check(
    `${label}: a paying request never falls open`,
    res.status === 502 &&
      res.json?.error === 'payment_unavailable' &&
      res.headers['cache-control'] === 'no-store' &&
      res.headers['x-d3-edge'] === 'fail-closed',
    res.text
  );

  // ── MCP over the REST API ──────────────────────────────────────────────────
  id = tag();
  res = await send(port, `${MCP}?t=${id}&scenario=jsonrpc402`, {
    method: 'POST',
    headers: JSON_TYPE,
    body: rpc('tools/call', { name: 'search', arguments: { q: 'a' } }),
  });
  s = await seen(id);
  check(
    `${label}: mcp: an unpaid call is answered in band with its id`,
    res.status === 200 &&
      res.json?.jsonrpc === '2.0' &&
      res.json?.id === 7 &&
      res.json?.result?.isError === true,
    res.text
  );
  check(
    `${label}: mcp: tagged payment-required, never cached`,
    res.headers['x-d3-edge'] === 'payment-required' && res.headers['cache-control'] === 'no-store',
    res.headers
  );
  check(
    `${label}: mcp: the call named on the payload`,
    JSON.stringify(s.decisions[0]?.payload.mcp) ===
      JSON.stringify({ method: 'tools/call', tool: 'search', source: 'body' }),
    s.decisions[0]?.payload.mcp
  );
  check(
    `${label}: mcp: the body digested`,
    s.decisions[0]?.payload.headers['content-digest'] ===
      digestOf(rpc('tools/call', { name: 'search', arguments: { q: 'a' } })),
    s.decisions[0]?.payload.headers
  );

  id = tag();
  const keyed = rpc('tools/call', {
    name: 'search',
    arguments: { q: 'a', n: 0.30000000000000004 },
    _meta: { 'dna.d3.com/key': 'dna_k_meta', progressToken: 3 },
  });
  res = await send(port, `${MCP}?t=${id}`, {
    method: 'POST',
    headers: { ...JSON_TYPE, 'content-digest': digestOf(keyed) },
    body: keyed,
  });
  s = await seen(id);
  check(
    `${label}: mcp: the key in _meta lifted onto the payload`,
    s.decisions[0]?.payload.headers['payment-authorization'] === 'Payment dna_k_meta',
    s.decisions[0]?.payload.headers
  );
  check(
    `${label}: mcp: WordPress gets the call without it`,
    res.json?.result?.echo &&
      !JSON.stringify(res.json.result.echo).includes('dna.d3.com') &&
      res.json.result.echo._meta?.progressToken === 3,
    res.text
  );
  check(
    `${label}: mcp: numbers reach WordPress exactly`,
    res.json?.result?.echo?.arguments?.n === 0.30000000000000004,
    res.json?.result?.echo
  );

  res = await send(port, `/mcp-raw?t=${tag()}`, { method: 'POST', headers: JSON_TYPE, body: keyed });
  check(
    `${label}: mcp: a plugin reading php://input gets the call without it too`,
    res.json?.result?.echo?.arguments?.q === 'a' &&
      !JSON.stringify(res.json?.result?.echo).includes('dna.d3.com'),
    res.text
  );

  id = tag();
  res = await send(port, `${MCP}?t=${id}`, {
    method: 'POST',
    headers: { ...JSON_TYPE, 'mcp-param-dna-key': 'dna_k_header' },
    body: rpc('tools/call', { name: 'search' }),
  });
  s = await seen(id);
  check(
    `${label}: mcp: the mirrored key goes to DNA as a payment, and the call is served`,
    s.decisions[0]?.payload.headers['payment-authorization'] === 'Payment dna_k_header' && res.json?.result,
    { dna: s.decisions[0]?.payload.headers, text: res.text }
  );

  id = tag();
  res = await send(port, `${MCP}?t=${id}`, {
    method: 'POST',
    headers: { ...JSON_TYPE, 'payment-authorization': 'Payment from-header' },
    body: rpc('tools/call', { name: 'search', _meta: { 'dna.d3.com/key': 'from-body' } }),
  });
  s = await seen(id);
  check(
    `${label}: mcp: a payment header the client sent wins over the one in the call`,
    s.decisions[0]?.payload.headers['payment-authorization'] === 'Payment from-header' &&
      !JSON.stringify(res.json?.result?.echo ?? {}).includes('from-body'),
    s.decisions[0]?.payload.headers
  );

  res = await send(port, `${MCP}?t=${tag()}&scenario=slowpay`, {
    method: 'POST',
    headers: JSON_TYPE,
    body: rpc('tools/call', { name: 'search', _meta: { 'dna.d3.com/key': 'k' } }),
  });
  check(
    `${label}: mcp: a payment lifted from the call never falls open`,
    res.status === 502 && res.json?.error === 'payment_unavailable',
    res.text
  );

  id = tag();
  await send(port, `${MCP}?t=${id}&_method=POST`, {
    method: 'PUT',
    headers: JSON_TYPE,
    body: rpc('tools/call', { name: 'search' }),
  });
  s = await seen(id);
  check(
    `${label}: mcp: a call WordPress serves as POST under _method is read as one`,
    s.decisions[0]?.payload.mcp?.tool === 'search' && s.decisions[0]?.payload.method === 'POST',
    s.decisions[0]?.payload
  );

  id = tag();
  res = await send(port, `${MCP}?t=${id}`, {
    method: 'POST',
    headers: JSON_TYPE,
    body: '{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"arguments":{"q":1e999,"dna_account_key":"SECRET"}}}',
  });
  s = await seen(id);
  check(
    `${label}: mcp: a call that cannot be written back without its key is refused`,
    res.status === 400 && res.json?.error === 'mcp_call_unreadable' && s.decisions.length === 0,
    res.text
  );

  res = await send(port, `/mcp-raw?t=${tag()}`, {
    method: 'POST',
    headers: { 'content-type': 'multipart/form-data' },
    body: rpc('tools/call', { name: 'a', arguments: { dna_account_key: 'SECRET' } }),
  });
  check(
    `${label}: mcp: a call under a multipart type PHP could not parse is refused`,
    res.status === 400 && !res.text.includes('SECRET'),
    res.text
  );

  res = await send(port, `${MCP}?t=${tag()}&scenario=jsonrpc402`, {
    method: 'POST',
    headers: JSON_TYPE,
    body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'search' } }),
  });
  check(
    `${label}: mcp: a priced notification gets the plain 402, with no id to answer`,
    res.status === 402 && res.json?.jsonrpc === undefined,
    res.text
  );

  res = await send(port, `${MCP}?t=${tag()}&scenario=paidmeta`, {
    method: 'POST',
    headers: JSON_TYPE,
    body: rpc('tools/call', { name: 'search' }),
  });
  check(
    `${label}: mcp: the receipt added to the result's _meta`,
    res.json?.result?._meta?.['x402/payment-response']?.success === true && res.json?.result?.content,
    res.text
  );
  check(
    `${label}: mcp: the rewritten result loses WordPress's etag and length, and is private`,
    res.headers.etag === undefined &&
      [undefined, String(Buffer.byteLength(res.text))].includes(res.headers['content-length']) &&
      /^private/.test(res.headers['cache-control'] ?? ''),
    {
      etag: res.headers.etag,
      length: res.headers['content-length'],
      bytes: Buffer.byteLength(res.text),
      cc: res.headers['cache-control'],
    }
  );
  check(
    `${label}: mcp: the REST API's CORS list kept beside ours`,
    headerValues(res, 'access-control-expose-headers').join(',').includes('X-WP-Total') &&
      headerValues(res, 'access-control-expose-headers').join(',').includes('payment-receipt'),
    headerValues(res, 'access-control-expose-headers')
  );

  res = await send(port, `${MCP}?t=${tag()}&scenario=meta`, {
    method: 'POST',
    headers: JSON_TYPE,
    body: rpc('tools/call', { name: 'search' }),
  });
  check(
    `${label}: mcp: a receipt only in _meta still makes the result private`,
    res.json?.result?._meta?.['x402/payment-response']?.success === true &&
      /^private/.test(res.headers['cache-control'] ?? '') &&
      res.headers['payment-receipt'] === undefined,
    { cc: res.headers['cache-control'], text: res.text }
  );

  res = await send(port, `/mcp-raw?t=${tag()}&scenario=paidmeta`, {
    method: 'POST',
    headers: { ...JSON_TYPE, 'x-test-ob-clean': '1' },
    body: rpc('tools/call', { name: 'search' }),
  });
  check(
    `${label}: mcp: a server that empties its buffer first still gets the receipt`,
    res.json?.result?._meta?.['x402/payment-response']?.success === true,
    res.text
  );

  res = await send(port, `/mcp-raw?t=${tag()}&scenario=meta`, {
    method: 'POST',
    headers: { ...JSON_TYPE, 'x-test-end-clean': '1' },
    body: rpc('tools/call', { name: 'search' }),
  });
  check(
    `${label}: mcp: a server that closes every buffer is still served, without the receipt`,
    res.json?.result?.content && res.json.result._meta === undefined,
    res.text
  );

  if (label === 'apache') {
    res = await send(port, `${MCP}?t=${tag()}&scenario=paidmeta`, {
      method: 'POST',
      headers: { ...JSON_TYPE, 'x-test-stray-newline': '1' },
      body: rpc('tools/call', { name: 'search' }),
    });
    check(
      `${label}: mcp: a stray newline before the result still gets the receipt`,
      res.json?.result?._meta?.['x402/payment-response']?.success === true,
      res.text
    );
    check(
      `${label}: mcp: and DNA's CORS entry survives the REST API replacing the list after it`,
      headerValues(res, 'access-control-expose-headers').join(',').includes('payment-receipt'),
      headerValues(res, 'access-control-expose-headers')
    );
  }

  res = await send(port, `/mcp-raw?t=${tag()}&scenario=paidmeta`, {
    method: 'POST',
    headers: { ...JSON_TYPE, 'x-test-keepalive': '1' },
    body: rpc('tools/call', { name: 'search' }),
  });
  check(
    `${label}: mcp: a keepalive flushed before the answer passes, not held`,
    res.status === 200 && res.text.startsWith(' ') && !res.text.includes('payment-response'),
    res.text
  );

  res = await send(port, `/mcp-sse?t=${tag()}&scenario=paidmeta`, {
    method: 'POST',
    headers: JSON_TYPE,
    body: rpc('tools/call', { name: 'search' }),
  });
  check(
    `${label}: mcp: an event stream passes untouched`,
    res.text.startsWith('event: message') && !res.text.includes('payment-response'),
    res.text
  );

  res = await send(port, `${MCP}?t=${tag()}&scenario=keyarg`, {
    method: 'POST',
    headers: JSON_TYPE,
    body: rpc('tools/list', {}),
  });
  check(
    `${label}: mcp: tools/list offers the key argument when the site turns it on`,
    res.json?.result?.tools?.[0]?.inputSchema?.properties?.dna_account_key?.['x-mcp-header'] === 'Dna-Key' &&
      res.json.result.tools[0].inputSchema.properties.q,
    res.text
  );
  res = await send(port, `${MCP}?t=${tag()}&scenario=keyargoff`, {
    method: 'POST',
    headers: JSON_TYPE,
    body: rpc('tools/list', {}),
  });
  check(
    `${label}: mcp: and not when it turns it off`,
    res.json?.result?.tools?.[0] && !res.json.result.tools[0].inputSchema.properties.dna_account_key,
    res.text
  );

  // A pass before identity carries no flag: the last decision that did is remembered.
  await send(port, `/page?t=${tag()}&scenario=keyarg`);
  res = await send(port, `${MCP}?t=${tag()}&scenario=early`, {
    method: 'POST',
    headers: JSON_TYPE,
    body: rpc('tools/list', {}),
  });
  check(
    `${label}: mcp: an early pass offers the key argument the last decision turned on`,
    res.json?.result?.tools?.[0]?.inputSchema?.properties?.dna_account_key !== undefined,
    res.text
  );
  await send(port, `/page?t=${tag()}&scenario=keyargoff`);
  res = await send(port, `${MCP}?t=${tag()}&scenario=early`, {
    method: 'POST',
    headers: JSON_TYPE,
    body: rpc('tools/list', {}),
  });
  check(
    `${label}: mcp: and forgets it once a decision turns it off`,
    res.json?.result?.tools?.[0] &&
      res.json.result.tools[0].inputSchema.properties.dna_account_key === undefined,
    res.text
  );

  id = tag();
  res = await send(port, `${MCP}?t=${id}`, {
    method: 'POST',
    headers: JSON_TYPE,
    body: rpc('tools/call', {
      name: 'a',
      arguments: { blob: 'x'.repeat(1_048_576) },
      _meta: { 'dna.d3.com/key': 'k' },
    }),
  });
  s = await seen(id);
  check(
    `${label}: mcp: a call too large to strip that names a credential is refused`,
    res.status === 413 && res.headers['x-d3-edge'] === 'fail-closed' && s.decisions.length === 0,
    { status: res.status, n: s.decisions.length }
  );

  id = tag();
  res = await send(port, `${MCP}?t=${id}`, {
    method: 'POST',
    headers: JSON_TYPE,
    body: `[${rpc('tools/call', { name: 'a', arguments: { dna_account_key: 'k' } })}]`,
  });
  s = await seen(id);
  check(
    `${label}: mcp: a batch carrying a credential is refused, not passed on`,
    res.status === 400 && res.json?.error === 'mcp_call_unreadable' && s.decisions.length === 0,
    res.text
  );

  // ── The body ───────────────────────────────────────────────────────────────
  id = tag();
  const big = 'b'.repeat(2 * 1024 * 1024);
  res = await send(port, `/upload?t=${id}`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: big,
  });
  s = await seen(id);
  check(
    `${label}: a body past the read cap is still digested`,
    s.decisions[0]?.payload.headers['content-digest'] === digestOf(big),
    s.decisions[0]?.payload.headers['content-digest']
  );
  check(`${label}: and reaches WordPress whole`, res.json?.bodyBytes === big.length, res.json?.bodyBytes);

  id = tag();
  res = await send(port, `/upload?t=${id}`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: ' '.repeat(1_200_000) + rpc('tools/call', { name: 'a', arguments: { dna_account_key: 'k' } }),
  });
  s = await seen(id);
  check(
    `${label}: a call behind a megabyte of whitespace naming a credential is refused`,
    res.status === 400 && s.decisions.length === 0,
    { status: res.status, n: s.decisions.length }
  );

  id = tag();
  const form = '--b\r\nContent-Disposition: form-data; name="f"; filename="a.txt"\r\n\r\nhello\r\n--b--\r\n';
  res = await send(port, `/upload?t=${id}`, {
    method: 'POST',
    headers: { 'content-type': 'multipart/form-data; boundary=b', 'content-digest': 'sha-256=:forged=:' },
    body: form,
  });
  s = await seen(id);
  check(
    `${label}: an upload PHP read for WordPress: the claimed digest dropped and named, never relayed`,
    s.decisions[0]?.payload.headers['content-digest'] === undefined &&
      s.decisions[0]?.payload.droppedHeaders?.includes('content-digest') &&
      res.json?.files?.[0] === 'f',
    { dna: s.decisions[0]?.payload, files: res.json?.files }
  );

  id = tag();
  await send(port, `/page?t=${id}`, { headers: { 'content-digest': 'sha-256=:forged=:' } });
  s = await seen(id);
  check(
    `${label}: an empty body's claimed digest is replaced by the empty one`,
    s.decisions[0]?.payload.headers['content-digest'] === digestOf(''),
    s.decisions[0]?.payload.headers
  );

  // WordPress serves any route from any path by ?rest_route=, so no path is let through undecided.
  res = await send(
    port,
    `/.well-known/acme-challenge/x?rest_route=/dna-test/v1/mcp&t=${tag()}&scenario=block`
  );
  check(`${label}: an ACME-shaped path is decided like any other`, res.status === 403, res.status);

  // ── WordPress's own headers, and DNA's beside them ────────────────────────
  res = await send(port, `/download?t=${tag()}&scenario=paid`);
  check(
    `${label}: a download that closes every buffer and sets its own caching is still private`,
    res.text === 'file bytes' &&
      res.headers['payment-receipt'] === 'receipt-1' &&
      /^private/.test(res.headers['cache-control'] ?? ''),
    res.headers
  );

  res = await send(port, `/page?t=${tag()}&scenario=paid`);
  check(
    `${label}: a paid page is kept out of page-cache plugins`,
    res.json?.pageCacheSkipped === true,
    res.json?.pageCacheSkipped
  );
  res = await send(port, `/page?t=${tag()}`);
  check(`${label}: an unpaid one is not`, res.json?.pageCacheSkipped === false, res.json?.pageCacheSkipped);

  id = tag();
  await send(port, `/page?t=${id}&scenario=block`, { headers: { host: 'evil.example' } });
  s = await seen(id);
  check(
    `${label}: a Host the site doesn't list is decided as the site's own`,
    s.decisions[0]?.payload.host === '127.0.0.1:8130',
    s.decisions[0]?.payload.host
  );
  id = tag();
  await send(port, `/wp-json/dna-test/v1/mcp?t=${id}&_method=POST`, {
    headers: JSON_TYPE,
    body: rpc('tools/call', { name: 'search' }),
  });
  s = await seen(id);
  check(
    `${label}: a GET the REST API runs as POST is decided as one`,
    s.decisions[0]?.payload.method === 'POST' && s.decisions[0]?.payload.mcp?.tool === 'search',
    s.decisions[0]?.payload
  );
  res = await send(port, `${MCP}?t=${tag()}&_method=PUT`, {
    method: 'POST',
    headers: { ...JSON_TYPE, 'x-test-internal-get': '1' },
    body: rpc('tools/call', { name: 'search' }),
  });
  check(
    `${label}: a route's own GET through the REST API, inside a request overridden to PUT, still runs`,
    res.json?.result?.internalGet === 200,
    res.text
  );

  id = tag();
  await send(port, `/blog//%77p-json/dna-test/v1/mcp?t=${id}`, {
    headers: { ...JSON_TYPE, 'x-http-method-override': 'POST' },
    body: rpc('tools/call', { name: 'search' }),
  });
  s = await seen(id);
  check(
    `${label}: and so is one under a subdirectory, written however WordPress still reads it`,
    s.decisions[0]?.payload.method === 'POST' && s.decisions[0]?.payload.mcp?.tool === 'search',
    s.decisions[0]?.payload
  );

  res = await send(port, `/page?t=${tag()}&scenario=paid`, { headers: { 'x-test-own-callback': '1' } });
  check(
    `${label}: a paid page is decorated beside the site's own header callback, which still runs`,
    res.headers['x-site-callback'] === 'ran' &&
      res.headers['payment-receipt'] === 'receipt-1' &&
      res.headers['cache-control'] === 'private, max-age=60',
    res.headers
  );

  res = await send(port, `/page?t=${tag()}&scenario=gate402mpp`);
  check(
    `${label}: a 402 with a WWW-Authenticate challenge stays a 402`,
    res.status === 402 && res.headers['www-authenticate']?.startsWith('Payment'),
    { status: res.status, headers: res.headers }
  );

  id = tag();
  const hash = 'a'.repeat(32);
  res = await send(port, `/page?t=${id}`, {
    headers: { cookie: `wordpress_logged_in_${hash}=admin%7Csecret; theme=dark` },
  });
  s = await seen(id);
  check(
    `${label}: a WordPress login cookie stays on the server, named as kept back`,
    s.decisions[0]?.payload.cookies?.[`wordpress_logged_in_${hash}`] === undefined &&
      s.decisions[0]?.payload.cookies?.theme === 'dark' &&
      s.decisions[0]?.payload.excluded?.cookies.includes(`wordpress_logged_in_${hash}`) &&
      res.json?.cookies[`wordpress_logged_in_${hash}`] !== undefined,
    s.decisions[0]?.payload
  );

  res = await send(port, `/page?t=${tag()}`, { method: 'HEAD' });
  check(
    `${label}: HEAD: tagged, no body`,
    res.headers['x-d3-edge'] === 'pass' && res.text === '',
    res.headers
  );

  // ── The check relay ────────────────────────────────────────────────────────
  const ANSWER = JSON.stringify({ v: 2, offer: 'o', signals: {} });
  const relayPath = (query = '') => `/.well-known/d3/check?t=${tag()}${query}`;
  const post = (headers = {}, body = ANSWER) => ({
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...headers },
    body,
  });
  const checksNow = async () => (await (await fetch(`${MOCK}/__log`)).json()).checks;
  const before = (await checksNow()).length;
  res = await send(port, relayPath(), post({ cookie: 'site=1' }));
  const relayed = (await checksNow()).slice(before);
  check(
    `${label}: relay: the check answer, never WordPress, and only cookies of ours`,
    res.status === 200 &&
      res.json?.next === 'reload' &&
      !res.json?.origin &&
      res.headers['x-d3-edge'] === 'check' &&
      res.headers['x-content-type-options'] === 'nosniff' &&
      headerValues(res, 'set-cookie').join('|') ===
        '__Host-d3check=sealed; Path=/; Secure; HttpOnly; SameSite=Lax',
    { status: res.status, headers: res.headers, text: res.text.slice(0, 200) }
  );
  check(
    `${label}: relay: /v1/check under the key, the answer whole, as a decision call describes it`,
    relayed.length === 1 &&
      relayed[0].auth === 'Bearer test-key' &&
      relayed[0].adapter === 'wordpress:1.1.0' &&
      relayed[0].relayed.answer === ANSWER &&
      relayed[0].relayed.payload.adapterSet === 4 &&
      relayed[0].relayed.payload.cookies?.site === '1' &&
      relayed[0].relayed.payload.headers['content-digest'] === digestOf(ANSWER),
    relayed
  );
  for (const [name, init, status, query] of [
    ['a GET is 405', { method: 'GET' }, 405, ''],
    ['a cross-site post is 403', post({ 'sec-fetch-site': 'cross-site' }), 403, ''],
    ['a post past 32 KiB is 413', post({}, 'x'.repeat(32 * 1024 + 1)), 413, ''],
    ['an empty post is 400', post({}, ''), 400, ''],
    ['an answer that is not JSON is 503', post(), 503, '&check=html'],
  ]) {
    const was = (await checksNow()).length;
    res = await send(port, relayPath(query), init);
    const relays = (await checksNow()).length - was;
    check(
      `${label}: relay: ${name}, never WordPress`,
      res.status === status &&
        !res.json?.origin &&
        !res.text.includes('<script>') &&
        relays === (query ? 1 : 0),
      { status: res.status, text: res.text.slice(0, 200) }
    );
  }
}

async function live() {
  for (const [label, site] of Object.entries(SITES)) await core(label, site);

  // ── Before the page cache, which only the wp-config.php line reaches ──────
  let res = await send(SITES.fpm.port, `/cached?t=${tag()}&scenario=block`);
  check(
    'cache: a blocked request never reaches the page cache',
    res.status === 403 && res.headers['x-d3-edge'] === 'block',
    res.text
  );
  res = await send(SITES.fpm.port, `/cached?t=${tag()}`, {
    headers: { cookie: `__Host-d3pay=${session}; a=1` },
  });
  check(
    'cache: a hit is tagged and holds none of ours',
    res.json?.cached && res.headers['x-d3-edge'] === 'pass' && res.json?.cookie === 'a=1',
    res.json
  );

  const log = phpLog();
  check('unauthorized: the error log says to check the key', /check DNA_API_KEY/.test(log));

  const timeouts = () => (phpLog().match(/decision call failed \(Operation timed out/g) ?? []).length;
  const before = timeouts();
  for (let i = 0; i < 5; i++) await send(SITES.fpm.port, `/page?t=${tag()}&scenario=slow`);
  check(
    'slow: timeouts are logged, once per interval however long each took',
    timeouts() >= 1 && timeouts() - before <= 1,
    {
      before,
      after: timeouts(),
    }
  );

  // The loop above timed out five times in ten seconds: unpaid requests now skip DNA for a while.
  let id = tag();
  const started = Date.now();
  res = await send(SITES.fpm.port, `/page?t=${id}&scenario=slow`);
  let s = await seen(id);
  check(
    'brownout: past five timeouts, a request that does not pay skips DNA and is served at once',
    res.headers['x-d3-edge'] === 'fail-open' &&
      res.json?.origin &&
      Date.now() - started < 400 &&
      s.decisions.length === 0,
    { edge: res.headers['x-d3-edge'], took: Date.now() - started, asked: s.decisions.length }
  );
  id = tag();
  res = await send(SITES.fpm.port, `/page?t=${id}`, { headers: { cookie: `__Host-d3pay=${session}` } });
  s = await seen(id);
  check(
    'brownout: a paying request still asks DNA',
    s.decisions.length === 1 && res.headers['x-d3-edge'] === 'pass',
    { edge: res.headers['x-d3-edge'], asked: s.decisions.length }
  );
}

async function dead() {
  const before = (phpLog().match(/decision call failed/g) ?? []).length;
  for (let i = 0; i < 20; i++) await send(SITES.fpm.port, `/page?t=${tag()}`);
  await sleep(200);
  const after = (phpLog().match(/decision call failed/g) ?? []).length;
  check('dead: twenty failed calls log one line, not twenty', after - before === 1, {
    before,
    after,
  });

  const res = await send(SITES.fpm.port, `/page?t=${tag()}`, {
    headers: { cookie: '__Host-d3visitor=v; a=1' },
  });
  check(
    'dead: the page, tagged fail-open, without ours',
    res.status === 200 && res.headers['x-d3-edge'] === 'fail-open' && res.json?.headers.cookie === 'a=1',
    res.headers
  );
  const paying = await send(SITES.fpm.port, `/page?t=${tag()}`, { headers: { 'x-payment': 'p' } });
  check(
    'dead: a paying one is a 502',
    paying.status === 502 && paying.json?.error === 'payment_unavailable',
    paying.text
  );
  const call = await send(SITES.fpm.port, `${MCP}?t=${tag()}`, {
    method: 'POST',
    headers: JSON_TYPE,
    body: rpc('tools/call', { name: 'search', arguments: { dna_account_key: 'k' } }),
  });
  check('dead: a call carrying a key is a 502', call.status === 502, call.text);
}

async function closed() {
  let res = await send(SITES.fpm.port, `/page?t=${tag()}&scenario=error500`);
  check(
    'closed: DNA failing is a 403, and WordPress never runs',
    res.status === 403 && res.headers['x-d3-edge'] === 'fail-closed' && !res.json?.origin,
    res.text
  );
  res = await send(SITES.fpm.port, `/page?t=${tag()}`);
  check('closed: a pass is still the page', res.status === 200 && res.json?.origin, res.status);
}

async function disabled() {
  const id = tag();
  const res = await send(SITES.fpm.port, `/page?t=${id}&d3pay_handoff=x&keep=1`, {
    headers: { cookie: '__Host-d3pay=s; a=1', 'payment-signature': 'p', 'x-d3-tier': 'proven' },
  });
  const s = await seen(id);
  check(
    'disabled: no call, tagged disabled',
    s.decisions.length === 0 && res.headers['x-d3-edge'] === 'disabled',
    res.headers
  );
  check(
    'disabled: still none of ours, nor a forged verdict, at WordPress',
    res.json?.headers.cookie === 'a=1' &&
      !res.json?.headers['payment-signature'] &&
      !res.json?.headers['x-d3-tier'] &&
      res.json?.url === `/page?t=${id}&keep=1`,
    res.json
  );
}

async function fromPlugin(entry) {
  const id = tag();
  let res = await send(SITES.fpm.port, `/page?t=${id}`, {
    headers: { cookie: `__Host-d3pay=${session}; a=1` },
  });
  const s = await seen(id);
  check(
    `${entry}: runs, and says from where`,
    res.headers['x-d3-edge'] === 'pass' && res.json?.entry === entry && s.decisions.length === 1,
    res.json?.entry
  );
  check(`${entry}: none of ours at WordPress`, res.json?.headers.cookie === 'a=1', res.json?.headers);
  res = await send(SITES.fpm.port, `/page?t=${tag()}&scenario=block`);
  check(`${entry}: a block is a 403`, res.status === 403 && res.json?.ruleId === 'rule-1', res.text);
  res = await send(SITES.fpm.port, `/page?t=${tag()}&scenario=paid`);
  check(
    `${entry}: a paid page is decorated`,
    res.headers['payment-receipt'] === 'receipt-1' && res.headers['cache-control'] === 'private, max-age=60',
    res.headers
  );
  // The documented cost of no wp-config.php line: a page cache answers before any plugin loads.
  res = await send(SITES.fpm.port, `/cached?t=${tag()}&scenario=block`);
  check(
    `${entry}: a page cache hit is served before DNA runs`,
    res.status === 200 && res.json?.cached && res.json?.entry === null,
    res.json
  );
}

async function prefix() {
  const call = rpc('tools/call', { name: 'search' });
  let res = await send(SITES.fpm.port, `/wp-api/dna-test/v1/mcp?t=${tag()}`, {
    method: 'POST',
    headers: JSON_TYPE,
    body: call,
  });
  check(
    'prefix: a call under the renamed prefix is served',
    res.json?.result?.content !== undefined,
    res.text
  );

  const id = tag();
  res = await send(SITES.fpm.port, `/wp-api/dna-test/v1/mcp?t=${id}&_method=POST`, {
    headers: JSON_TYPE,
    body: call,
  });
  const s = await seen(id);
  check(
    'prefix: a GET the REST API would run as POST is refused, not run as the free handshake',
    s.decisions[0]?.payload.method === 'GET' &&
      res.status === 400 &&
      res.json?.code === 'dna_method_override_refused' &&
      !res.json?.result,
    { status: res.status, text: res.text }
  );

  for (const [method, override] of [
    ['GET', 'PUT'],
    ['DELETE', 'PATCH'],
  ]) {
    res = await send(SITES.fpm.port, `/wp-api/dna-test/v1/mcp?t=${tag()}`, {
      method,
      headers: { ...JSON_TYPE, 'x-http-method-override': override },
      body: call,
    });
    check(
      `prefix: a ${method} run as ${override} is refused too`,
      res.status === 400 && !res.json?.result,
      res.status
    );
  }

  res = await send(SITES.fpm.port, `/wp-api/dna-test/v1/mcp?t=${tag()}`, {
    method: 'POST',
    headers: { ...JSON_TYPE, 'x-http-method-override': 'PUT' },
    body: call,
  });
  check(
    'prefix: a POST the editor overrides to PUT still runs',
    res.json?.result?.content !== undefined,
    res.text
  );

  res = await send(SITES.fpm.port, `/page?t=${tag()}`, { headers: { 'x-test-internal-post': '1' } });
  check(
    "prefix: a plugin's own POST through the REST API during a page view still runs",
    res.json?.internalPost === 200,
    res.json?.internalPost
  );
}

async function unloaded() {
  let res = await send(SITES.fpm.port, `/page?t=${tag()}`, {
    headers: { cookie: 'a=1', 'x-d3-tier': 'proven' },
  });
  check(
    'no Runtime.php: the page, tagged fail-open',
    res.status === 200 && res.headers['x-d3-edge'] === 'fail-open' && !res.json?.headers['x-d3-tier'],
    res.headers
  );
  res = await send(SITES.fpm.port, `/page?t=${tag()}`, { headers: { cookie: '__Host-d3pay=s; a=1' } });
  check(
    'no Runtime.php: a cookie of ours is refused, never handed to WordPress',
    res.status === 502 && res.headers['x-d3-edge'] === 'fail-closed',
    res.status
  );
  res = await send(SITES.fpm.port, `/page?t=${tag()}`, { headers: { cookie: '__Secure-d3visitor=v; a=1' } });
  check(
    'no Runtime.php: a returning visitor is served, with no cookie of ours',
    res.status === 200 && res.json?.headers.cookie === 'a=1',
    { status: res.status, cookie: res.json?.headers.cookie }
  );
  res = await send(SITES.fpm.port, `/page?t=${tag()}&d3pay%5Fhandoff=x`);
  check('no Runtime.php: an escaped param of ours is refused', res.status === 502, res.status);
  res = await send(SITES.fpm.port, `/cached?t=${tag()}`, {
    headers: { cookie: '__Secure-d3visitor=v; a=1' },
  });
  check(
    'no Runtime.php: a page cache finds no cookie of ours in $_REQUEST either',
    res.json?.request.includes('a') && !res.json.request.some((name) => name.includes('d3')),
    res.json
  );
  res = await send(SITES.fpm.port, `/mcp-raw?t=${tag()}`, {
    method: 'POST',
    headers: JSON_TYPE,
    body: rpc('tools/call', { name: 'a', _meta: { 'dna.d3.com/key': 'k' } }),
  });
  check('no Runtime.php: a key in a call is refused', res.status === 502, res.status);
  check(
    'no Runtime.php: named in the error log once, not per request',
    (phpLog().match(/src is missing/g) ?? []).length === 1
  );
  // Padding first, so neither `jsonrpc` nor the key sits in the first megabyte.
  const padded = `{"params":{"arguments":{"pad":"${'x'.repeat(1_100_000)}","dna_account_key":"k"}},"jsonrpc":"2.0","id":1,"method":"tools/call"}`;
  res = await send(SITES.fpm.port, `/mcp-raw?t=${tag()}`, {
    method: 'POST',
    headers: JSON_TYPE,
    body: padded,
  });
  check(
    'no Runtime.php: a key past the first megabyte of a call is still refused',
    res.status === 502,
    res.status
  );
}

const PHASES = {
  live,
  dead,
  closed,
  disabled,
  'mu-plugin': () => fromPlugin('mu-plugin'),
  plugin: () => fromPlugin('plugin'),
  unloaded,
  prefix,
};
await PHASES[phase]();
console.log(`${phase}: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
