// Revision-2 checks against real Caddy. `node run.mjs live` with the mock worker
// up, `node run.mjs dead` with it stopped.
import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';

const BARE = 'http://127.0.0.1:8080';
const FLEET = 'http://127.0.0.1:8085';
const WORKER = 'http://127.0.0.1:9000';
let pass = 0,
  fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    fail++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `\n      ${detail}` : ''}`);
  }
};

const visit = async (path, { site = BARE, scenario, headers = {}, method = 'GET', body } = {}) => {
  const t0 = Date.now();
  const res = await fetch(site + path, {
    method,
    body,
    redirect: 'manual',
    headers: { ...(scenario ? { 'x-test-scenario': scenario } : {}), ...headers },
  });
  const text = await res.text();
  return {
    res,
    text,
    ms: Date.now() - t0,
    json: (() => {
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    })(),
  };
};

const subrequests = async () => (await fetch(`${WORKER}/__log`)).json();
const lastSubrequest = async () => (await subrequests()).at(-1);
const reset = () => fetch(`${WORKER}/__reset`);
const h = (r, n) => r.res.headers.get(n);
const served = (r) => r.res.status === 200 && r.json?.origin === true;
const unavailable = (r) => r.res.status === 502 && r.json?.error === 'payment_unavailable' && !r.json?.origin;
const PAYING = { cookie: '__Host-d3pay=SESS42' };

// fetch always sends Accept-Encoding; node:http sends only what it is given.
const rawGet = (path, headers) =>
  new Promise((resolve, reject) => {
    const req = httpRequest(BARE + path, { headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });

// HTTP/1.0 may omit Host, which no client library will.
const hostless = (path) =>
  new Promise((resolve, reject) => {
    const socket = connect(8080, '127.0.0.1', () => socket.write(`GET ${path} HTTP/1.0\r\n\r\n`));
    let reply = '';
    socket.on('data', (chunk) => (reply += chunk));
    socket.on('end', () => resolve(Number(reply.split(' ')[1])));
    socket.on('error', reject);
  });

const firstByte = async (path, scenario) => {
  const t0 = Date.now();
  const res = await fetch(BARE + path, { headers: { 'x-test-scenario': scenario } });
  const reader = res.body.getReader();
  await reader.read();
  const ms = Date.now() - t0;
  await reader.cancel();
  return { res, ms };
};

if (process.argv[2] === 'live') {
  console.log('\n=== Answers the visitor sees');
  let r = await visit('/a', { scenario: 'pass' });
  ok('pass: origin served, x-d3-edge: pass', served(r) && h(r, 'x-d3-edge') === 'pass');
  ok(
    'pass: no empty payment headers added',
    !['payment-receipt', 'payment-response', 'x-payment-response'].some((n) => r.res.headers.has(n))
  );
  ok(
    'pass: origin caching and cookies untouched',
    h(r, 'cache-control') === 'public, max-age=60' &&
      r.res.headers.getSetCookie().join('|') === 'site_session=KEEP; Path=/'
  );
  r = await visit('/a', { scenario: 'block' });
  ok(
    'block: 403 with its body, origin not reached',
    r.res.status === 403 && r.text.includes('blocked') && !r.json?.origin
  );
  r = await visit('/a', { scenario: 'gate402' });
  ok('charge: 402 with the challenge body', r.res.status === 402 && r.json?.error === 'payment_required');
  ok(
    'charge: every challenge header arrives once',
    ['payment-required', 'link', 'retry-after', 'access-control-expose-headers'].every((n) =>
      r.res.headers.has(n)
    ) &&
      h(r, 'cache-control') === 'no-store' &&
      h(r, 'x-d3-edge') === 'payment-required'
  );
  r = await visit('/a', { scenario: 'gate402html' });
  ok(
    'charge (browser): 402 paywall page',
    r.res.status === 402 && h(r, 'content-type')?.startsWith('text/html') && r.text.includes('Pay to read')
  );
  r = await visit('/a', { scenario: 'stub' });
  ok(
    'pay copy: a 200 served in place of the page',
    r.res.status === 200 &&
      r.text.includes('This page costs') &&
      !r.json?.origin &&
      h(r, 'x-d3-edge') === 'payment-stub',
    `x-d3-edge=${h(r, 'x-d3-edge')}`
  );
  ok(
    'pay copy: no header doubled',
    h(r, 'content-type') === 'text/html; charset=utf-8' && h(r, 'cache-control') === 'no-store'
  );
  r = await visit('/a', { scenario: 'redirect' });
  ok(
    'navigating browser: 302 to the pay app with its Link',
    r.res.status === 302 && h(r, 'location')?.includes('dna.d3.com') && r.res.headers.has('link')
  );
  r = await visit('/a', { scenario: 'redeem' });
  ok(
    'redemption: 302 back with the new session cookie',
    r.res.status === 302 && r.res.headers.getSetCookie().some((c) => c.startsWith('__Host-d3pay=NEWSESSION'))
  );
  r = await visit('/a', { scenario: 'unavailable' });
  ok('payment unavailable: 502, never the page', unavailable(r));

  console.log('\n=== A paid request gets the page, plus what the answer added');
  r = await visit('/a', { scenario: 'paid_dna' });
  const cookies = r.res.headers.getSetCookie();
  ok('DNA charge: page served with Payment-Receipt', served(r) && r.res.headers.has('payment-receipt'));
  ok(
    "DNA charge: our Set-Cookie appended, the site's kept",
    cookies.includes('site_session=KEEP; Path=/') &&
      cookies.some((c) => c.startsWith('__Host-d3pay=ROTATED')),
    cookies.join(' | ')
  );
  ok(
    "DNA charge: CORS list appended, the site's kept",
    /x-site-thing/.test(h(r, 'access-control-expose-headers')) &&
      /payment-receipt/.test(h(r, 'access-control-expose-headers'))
  );
  ok(
    'DNA charge: the origin never saw the receipt or our cookie',
    !JSON.stringify(r.json?.headers ?? {}).includes('ROTATED') &&
      !JSON.stringify(r.json?.headers ?? {}).includes('eyJzdGF0dXMi')
  );
  for (const [scenario, header] of [
    ['paid_x402', 'payment-response'],
    ['paid_x402_v1', 'x-payment-response'],
  ]) {
    r = await visit('/a', { scenario });
    ok(
      `${scenario}: ${header} relayed, CORS appended, narrowed`,
      r.res.headers.has(header) &&
        new RegExp(header).test(h(r, 'access-control-expose-headers')) &&
        /x-site-thing/.test(h(r, 'access-control-expose-headers')) &&
        h(r, 'cache-control') === 'private, max-age=60'
    );
  }

  console.log('\n=== Cache-Control on a paid page, against privateCacheControl in the DNA core');
  const NARROWED = [
    ['public, s-maxage=60, stale-while-revalidate=300', 'private, s-maxage=60, stale-while-revalidate=300'],
    ['max-age=60', 'private, max-age=60'],
    ['private, max-age=60', 'private, max-age=60'],
    ['no-store', 'no-store'],
    ['(absent)', 'private'],
    ['max-age=0, must-revalidate, public', 'max-age=0, must-revalidate, private'],
    ['private="set-cookie", max-age=5', 'private, private="set-cookie", max-age=5'],
    ['no-cache', 'private, no-cache'],
    ['public, max-age=60, public', 'private, max-age=60, public'],
  ];
  for (const [origin, core] of NARROWED) {
    r = await visit('/a', { scenario: 'paid_dna', headers: { 'x-test-origin-cc': origin } });
    ok(`${origin.padEnd(48)} -> ${core}`, h(r, 'cache-control') === core, `got ${h(r, 'cache-control')}`);
  }

  console.log('\n=== What leaves Caddy, in each direction');
  await reset();
  r = await visit('/article?a=1&d3pay_handoff=H123&d3pay_check=C1&d3pay_browser=B1&b=2', {
    scenario: 'pass',
    headers: {
      cookie: '__Host-d3pay=SESS42; site=1; __Host-d3person=PASS7; theme=dark',
      'payment-signature': 'sig',
      'x-payment': 'xp',
      'payment-authorization': 'Payment abc',
      'd3pay-session': 'SPOOF',
      'd3pay-person': 'SPOOF',
      'x-d3-adapter-set': '99',
      'dna-adapter': 'cloudflare:99.0.0',
      'x-d3-adapter-key': 'forged',
      'x-forwarded-host': 'other.example',
      authorization: 'Bearer site-token',
      'x-partner-id': 'acme',
      'x-d3-excluded-headers': 'x-bot-token',
      'x-d3-excluded-cookies': 'gate',
      'x-original-url': 'http://127.0.0.1:8080/free',
      'x-original-method': 'GET',
      'mcp-param-dna-key': 'dna_k_1',
    },
  });
  let sub = await lastSubrequest();
  ok(
    'to DNA: our cookies only by name, never in the jar',
    !/__Host-d3/.test(sub.headers.cookie ?? ''),
    `cookie=${sub.headers.cookie}`
  );
  ok(
    'to DNA: never an X-Original-* the visitor set',
    !('x-original-url' in sub.headers) && !('x-original-method' in sub.headers)
  );
  ok(
    "to DNA: our two cookies by name, never the visitor's spoofed headers",
    sub.headers['d3pay-session'] === 'SESS42' && sub.headers['d3pay-person'] === 'PASS7'
  );
  ok(
    "to DNA: the cookie jar and every header, revision 2 over the visitor's 99",
    /site=1/.test(sub.headers.cookie) &&
      /theme=dark/.test(sub.headers.cookie) &&
      sub.headers['x-partner-id'] === 'acme' &&
      sub.headers['x-d3-adapter-set'] === '2',
    `cookie=${sub.headers.cookie}`
  );
  ok(
    "to DNA: names this file's build, never the visitor's dna-adapter",
    sub.headers['dna-adapter'] === 'caddy:1.0.1',
    `dna-adapter=${sub.headers['dna-adapter']}`
  );
  ok(
    "to DNA: the key from DNA_API_KEY, never the visitor's",
    sub.headers['x-d3-adapter-key'] === 'test-key',
    `key=${sub.headers['x-d3-adapter-key']}`
  );
  ok('to DNA: never Authorization', !('authorization' in sub.headers));
  ok(
    "to DNA: the site's exclusions, never the visitor's",
    sub.headers['x-d3-excluded-headers'] === 'x-internal-token' &&
      sub.headers['x-d3-excluded-cookies'] === 'sid',
    `headers=${sub.headers['x-d3-excluded-headers']} cookies=${sub.headers['x-d3-excluded-cookies']}`
  );
  ok(
    'to DNA: every payment header arrives',
    sub.headers['payment-signature'] === 'sig' &&
      sub.headers['x-payment'] === 'xp' &&
      sub.headers['payment-authorization'] === 'Payment abc'
  );
  ok(
    'to DNA: the full URL, our params included',
    sub.headers['x-forwarded-uri'].includes('d3pay_handoff=H123')
  );
  ok(
    'to DNA: the real Host, not a spoofed X-Forwarded-Host',
    sub.headers['x-forwarded-host'] === '127.0.0.1:8080',
    `got ${sub.headers['x-forwarded-host']}`
  );
  ok('to DNA: a body-less GET', sub.method === 'GET' && sub.bodyBytes === 0);
  let o = r.json?.headers ?? {};
  ok("to origin: only the site's own cookies", o.cookie === 'site=1; theme=dark', `cookie=${o.cookie}`);
  ok(
    'to origin: no payment header, no d3pay header, no DNA key',
    ![
      'payment-signature',
      'x-payment',
      'payment-authorization',
      'd3pay-session',
      'd3pay-person',
      'mcp-param-dna-key',
    ].some((n) => n in o)
  );
  ok(
    "to origin: our params gone, the site's kept",
    !/d3pay/.test(r.json?.url) && /a=1/.test(r.json?.url) && /b=2/.test(r.json?.url),
    r.json?.url
  );

  r = await visit('/a', {
    scenario: 'pass',
    headers: { cookie: 'a=1; __Host-d3pay =SESS42; __Host-d3person\t= PASS7; b=2' },
  });
  ok(
    'to origin: our cookies gone under any spacing',
    !/d3pay|d3person/.test(r.json?.headers?.cookie ?? ''),
    `cookie=${r.json?.headers?.cookie}`
  );

  // The visitor id is often the only cookie of ours a request holds.
  for (const name of ['__Host-d3visitor', '__Secure-d3visitor']) {
    for (const scenario of ['pass', 'infra500']) {
      r = await visit('/a', { scenario, headers: { cookie: `site=1; ${name}=V1` } });
      sub = await lastSubrequest();
      ok(
        `ours: ${name} alone reaches DNA on ${scenario}, and never the origin`,
        (sub.headers.cookie ?? '').includes(`${name}=V1`) && r.json?.headers?.cookie === 'site=1',
        `dna=${sub.headers.cookie} origin=${r.json?.headers?.cookie}`
      );
    }
  }

  const raw = '/q?b=2&a=1&s=%20x&plus=a+b&flag&enc=%2F';
  r = await visit(raw, { scenario: 'pass' });
  ok('to origin: a query with none of ours, byte for byte', r.json?.url === raw, r.json?.url);

  await reset();
  await rawGet('/a', { 'x-test-scenario': 'pass' });
  sub = await lastSubrequest();
  ok(
    'to DNA: no Accept-Encoding the visitor never sent',
    !('accept-encoding' in sub.headers),
    `accept-encoding=${sub.headers['accept-encoding']}`
  );

  await reset();
  const upgraded = await rawGet('/a', { 'x-test-scenario': 'block', connection: 'Upgrade', upgrade: 'foo' });
  sub = await lastSubrequest();
  ok(
    'to DNA: never an Upgrade, which HTTP/2 to DNA would refuse',
    upgraded === 403 && !('upgrade' in sub.headers),
    `status=${upgraded} upgrade=${sub.headers.upgrade}`
  );

  const noHost = await hostless('/a');
  ok('a request with no Host is refused, never failed open', noHost === 400, `status=${noHost}`);
  const dotHost = await rawGet('/a', { host: '..', 'x-test-scenario': 'pass' });
  ok('a Host of only dots is refused too', dotHost === 400, `status=${dotHost}`);

  r = await visit('/a', { scenario: 'pass_cached' });
  ok(
    "any caching but no-store on DNA's answer never replaces the origin's",
    served(r) && h(r, 'cache-control') === 'public, max-age=60',
    `cache-control=${h(r, 'cache-control')}`
  );

  for (const scenario of ['check_passed', 'day_pass']) {
    r = await visit('/a', { scenario });
    ok(
      `${scenario}: the page, with DNA's no-store over the origin's caching`,
      served(r) && h(r, 'cache-control') === 'no-store',
      `status=${r.res.status} cache-control=${h(r, 'cache-control')}`
    );
  }

  const stream = await firstByte('/stream', 'paid_dna');
  ok(
    'a paid page streams, narrowed, never buffered whole',
    stream.ms < 1000 && stream.res.headers.get('cache-control') === 'private, max-age=60',
    `first byte after ${stream.ms}ms, cache-control=${stream.res.headers.get('cache-control')}`
  );

  await reset();
  await visit('/a', { scenario: 'pass', headers: { 'd3pay-session': 'SPOOF' } });
  sub = await lastSubrequest();
  ok('to DNA: a spoofed d3pay-session with no cookie is dropped', !sub.headers['d3pay-session']);
  await reset();
  r = await visit('/form', {
    scenario: 'pass',
    method: 'POST',
    body: 'x'.repeat(5000),
    headers: { 'content-type': 'text/plain' },
  });
  sub = await lastSubrequest();
  ok('POST: DNA gets no body, the origin gets all of it', sub.bodyBytes === 0 && r.json?.bodyBytes === 5000);

  console.log("\n=== A site built of handle blocks and try_files (the fleet's shape)");
  await reset();
  r = await visit('/premium/article?x=1', { site: FLEET, scenario: 'block' });
  ok('block still blocks beside handle', r.res.status === 403 && !r.json?.origin, `status=${r.res.status}`);
  sub = await lastSubrequest();
  ok(
    "DNA judges the URL the visitor sent, not try_files' rewrite",
    sub?.headers['x-forwarded-uri'] === '/premium/article?x=1',
    `got ${sub?.headers['x-forwarded-uri']}`
  );
  r = await visit('/premium/article?x=1', {
    site: FLEET,
    scenario: 'paid_dna',
    headers: { cookie: '__Host-d3pay=SESS42; site=1' },
  });
  ok(
    'a paid page there gets its receipt, narrowed',
    served(r) && r.res.headers.has('payment-receipt') && h(r, 'cache-control') === 'private, max-age=60'
  );
  ok(
    'and the origin there sees no credential',
    r.json?.headers?.cookie === 'site=1',
    `cookie=${r.json?.headers?.cookie}`
  );
  r = await visit('/api/x', { site: FLEET, scenario: 'gate402' });
  ok('a gate reaches the visitor from inside a handle block', r.res.status === 402);

  console.log('\n=== DNA down, or answering because it failed');
  for (const [scenario, status] of [
    ['infra414', 414],
    ['infra431', 431],
  ]) {
    r = await visit('/a', { scenario });
    ok(
      `${scenario}: returned as it came, never the page`,
      r.res.status === status && !served(r),
      `status=${r.res.status}`
    );
  }

  r = await visit('/a', {
    scenario: 'block',
    headers: { cookie: `__Host-d3person=${'a'.repeat(12 * 1024)}` },
  });
  ok(
    'an oversized person cookie still reaches DNA',
    r.res.status === 403 && !served(r),
    `status=${r.res.status}`
  );

  for (const scenario of ['infra522', 'infra500', 'infra429', 'worker_fail_open']) {
    r = await visit('/a', { scenario });
    ok(
      `${scenario}, unpaid: the page, tagged fail-open`,
      served(r) && h(r, 'x-d3-edge') === 'fail-open',
      `status=${r.res.status} edge=${h(r, 'x-d3-edge')}`
    );
    r = await visit('/a', { scenario, headers: PAYING });
    ok(`${scenario}, paying: 502, never the page`, unavailable(r), `status=${r.res.status}`);
  }

  console.log('\n=== Budgets (test values: 500ms unpaid, 3s paying)');
  r = await visit('/a', { scenario: 'pass', headers: { 'x-test-delay-ms': '1000' } });
  ok(
    `unpaid + slow DNA: fail-open to the page in ${r.ms}ms`,
    served(r) && h(r, 'x-d3-edge') === 'fail-open' && r.ms < 900
  );
  const triggers = {
    'Payment-Signature': { 'payment-signature': 'sig' },
    'X-Payment': { 'x-payment': 'xp' },
    'Payment-Authorization': { 'payment-authorization': 'Payment abc' },
    '__Host-d3pay cookie': PAYING,
  };
  for (const [name, headers] of Object.entries(triggers)) {
    r = await visit('/a', { scenario: 'pass', headers: { ...headers, 'x-test-delay-ms': '1000' } });
    ok(
      `paying by ${name}: waits for DNA (${r.ms}ms)`,
      served(r) && h(r, 'x-d3-edge') === 'pass' && r.ms >= 950
    );
  }

  r = await visit('/a?d3pay_handoff=H1', { scenario: 'pass', headers: { 'x-test-delay-ms': '1000' } });
  ok(
    `paying by ?d3pay_handoff: waits for DNA (${r.ms}ms)`,
    served(r) && h(r, 'x-d3-edge') === 'pass' && r.ms >= 950
  );
  r = await visit('/a', {
    scenario: 'pass',
    headers: { 'x-test-delay-ms': '1000', cookie: '__Host-d3person=PASS7' },
  });
  ok(
    `the person pass alone does not buy the paying budget (${r.ms}ms)`,
    r.ms < 900 && h(r, 'x-d3-edge') === 'fail-open'
  );
  r = await visit('/a', { scenario: 'paid_dna', headers: { ...PAYING, 'x-test-delay-ms': '4000' } });
  ok(`paying past its ceiling: 502 (${r.ms}ms)`, unavailable(r) && r.ms < 3800, `status=${r.res.status}`);
}

if (process.argv[2] === 'dead') {
  console.log('\n=== DNA unreachable');
  let r = await visit('/a');
  ok('unpaid: fail-open, the page is served', served(r) && h(r, 'x-d3-edge') === 'fail-open');
  r = await visit('/a', { headers: PAYING });
  ok('paying: 502 payment_unavailable, never the page', unavailable(r));
  r = await visit('/a', { site: FLEET });
  ok('unpaid, handle-shaped site: fail-open', served(r));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
