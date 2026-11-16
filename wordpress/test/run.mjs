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
    `${label}: pass: one decision, revision 3`,
    s.decisions.length === 1 && p.adapterSet === 3 && p.headerSet === 2,
    s.decisions.length
  );
  check(`${label}: pass: the key as a bearer`, s.decisions[0]?.auth === 'Bearer test-key');
  check(
    `${label}: pass: names this plugin, never the visitor's dna-adapter`,
    s.decisions[0]?.adapter === 'wordpress:1.0.0',
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
  res = await send(port, `/page?t=${tag()}`, { headers: { x_d3_tier: 'proven' } });
  check(
    `${label}: pass with a verdict: DNA's replaces the visitor's, however spelled`,
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
          res.json?.headers.cookie === 'site=1' &&
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
      'mcp-param-dna-key': 'dna_k',
      'x-payment': 'p',
      cookie: '__Host-d3person =x',
    },
  });
  const oh = res.json?.headers ?? {};
  check(
    `${label}: strip: no payment header, mirrored key or cookie of ours at WordPress`,
    !oh['payment-authorization'] &&
      !oh['mcp-param-dna-key'] &&
      !oh['x-payment'] &&
      !oh.cookie &&
      Object.keys(res.json?.cookies ?? {}).length === 0,
    { oh, cookies: res.json?.cookies }
  );
  check(
    `${label}: strip: our params gone from the URI, the rest in order`,
    res.json?.url === `/page?t=${id}&keep=1&d3pay.handoff=x` &&
      res.json?.query === `t=${id}&keep=1&d3pay.handoff=x`,
    res.json?.url
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
    check(`${label}: ${scenario}: within the budget`, took < 1500, took);
    check(
      `${label}: ${scenario}: still no credential at WordPress`,
      !/__Host-d3person/.test(res.json?.headers.cookie ?? ''),
      res.json?.headers
    );
    if (reports) {
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

  res = await send(port, `${MCP}?t=${tag()}`, {
    method: 'POST',
    headers: { ...JSON_TYPE, 'mcp-param-dna-key': 'dna_k_header' },
    body: rpc('tools/call', { name: 'search' }),
  });
  check(
    `${label}: mcp: the mirrored key never reaches WordPress`,
    res.status === 200 && res.json?.result,
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

  id = tag();
  res = await send(port, `/.well-known/acme-challenge/tok?t=${id}`);
  s = await seen(id);
  check(
    `${label}: an ACME challenge is never decided`,
    s.decisions.length === 0 && res.headers['x-d3-edge'] === 'pass',
    s.decisions.length
  );
  id = tag();
  await send(port, `/.well-known/acme-challenge/../../page?t=${id}`);
  s = await seen(id);
  check(`${label}: a path that only starts like one is`, s.decisions.length === 1, s.decisions.length);

  res = await send(port, `/page?t=${tag()}`, { method: 'HEAD' });
  check(
    `${label}: HEAD: tagged, no body`,
    res.headers['x-d3-edge'] === 'pass' && res.text === '',
    res.headers
  );
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
}

async function dead() {
  const before = (phpLog().match(/decision call failed/g) ?? []).length;
  for (let i = 0; i < 20; i++) await send(SITES.fpm.port, `/page?t=${tag()}`);
  await sleep(200);
  const after = (phpLog().match(/decision call failed/g) ?? []).length;
  check('dead: twenty failed calls log one line, not twenty', after - before <= 1, after - before);

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
  res = await send(SITES.fpm.port, `/page?t=${tag()}&d3pay%5Fhandoff=x`);
  check('no Runtime.php: an escaped param of ours is refused', res.status === 502, res.status);
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
}

const PHASES = {
  live,
  dead,
  disabled,
  'mu-plugin': () => fromPlugin('mu-plugin'),
  plugin: () => fromPlugin('plugin'),
  unloaded,
};
await PHASES[phase]();
console.log(`${phase}: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
