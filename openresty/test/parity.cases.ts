// What the protocol package answers for each input, written to parity.json so
// the OpenResty port (openresty/dna.lua) is checked against it under real OpenResty.
import { liftedPaymentToForward, mcpCarriageOf } from '../../packages/protocol/src/adapter/mcp.ts';
import {
  MCP_KEY_ARGUMENT_SCHEMA,
  unreadableCallResponse,
  withMcpResult,
} from '../../packages/protocol/src/adapter/mcp-response.ts';
import { privateCacheControl } from '../../packages/protocol/src/adapter/payment-response.ts';
import {
  ADAPTER_SET,
  buildPaymentResponse,
  cookiesOf,
  debugHeadersOf,
  exclusionOverflowWarning,
  forwardAll,
  FORWARDED_HEADER_SET,
  FORWARDED_HEADERS,
  HEADER_LENGTH_CAPS,
  NEVER_FORWARDED_HEADERS,
  parseExclusionList,
  paymentEdgeMode,
  readAdapterSettings,
  readCookie,
  recordableName,
  stripOwnCookies,
  stripPayParams,
  withheldOf,
  type ForwardExclusions,
  type PaymentInstruction,
} from '../../packages/protocol/src/index.ts';

type Pairs = [string, string][];

const NONE: ForwardExclusions = { headers: [], cookies: [] };
const long = (n: number, c = 'x') => c.repeat(n);
const names = (n: number) => Array.from({ length: n }, (_, i) => `x-${i}`);
const handoff = `${long(22, 'A')}.${long(43, 'b')}`;

const forwardAllCases: { name: string; headers: Pairs; exclude: ForwardExclusions }[] = [
  {
    name: 'every header but the never-sent, every cookie but ours',
    headers: [
      ['User-Agent', 'agent/1'],
      ['Accept', 'text/html'],
      ['X-Custom', 'yes'],
      ['Cookie', 'a=1; b=2; __Host-d3pay=SESSION; __Host-d3person=PASS'],
      ['Authorization', 'Bearer secret'],
      ['Proxy-Authorization', 'Basic x'],
      ['Content-Length', '12'],
      ['Connection', 'keep-alive'],
      ['Transfer-Encoding', 'chunked'],
      ['X-Vercel-Oidc-Token', 't'],
      ['Cf-Access-Jwt-Assertion', 'j'],
      ['Mcp-Param-Dna-Key', 'dna_k_1'],
    ],
    exclude: NONE,
  },
  {
    name: 'exclusions keep a header and a cookie back',
    headers: [
      ['x-internal-token', 'keep-me-home'],
      ['x-other', 'go'],
      ['cookie', 'sid=private; theme=dark'],
    ],
    exclude: { headers: ['x-internal-token'], cookies: ['sid'] },
  },
  {
    name: 'ours ride outside the shared cookie cap',
    headers: [
      ['Cookie', `${Array.from({ length: 300 }, (_, i) => `c${i}=v`).join('; ')}; __Secure-d3visitor=V`],
    ],
    exclude: NONE,
  },
  {
    name: 'the id we set outlasts cookies wearing our prefix',
    headers: [
      [
        'Cookie',
        `${Array.from({ length: 20 }, (_, i) => `__Secure-d3pad${i}=v`).join('; ')}; __Secure-d3visitor=V`,
      ],
    ],
    exclude: NONE,
  },
  {
    name: 'a named cap drops its header, under it the header goes',
    headers: [
      ['accept', long(257)],
      ['sec-fetch-mode', 'navigate'],
      ['payment-authorization', `Payment ${long(4000)}`],
      ['dpop', long(8193)],
    ],
    exclude: NONE,
  },
  {
    name: 'past the per-value cap a header and a cookie are dropped',
    headers: [
      ['x-big', long(2049)],
      ['x-fits', long(2048)],
      ['cookie', `huge=${long(2049)}; small=1`],
    ],
    exclude: NONE,
  },
  {
    name: 'past the total the longest go first',
    headers: [
      ['x-a', long(2000)],
      ['x-b', long(2000)],
      ['x-c', long(2000)],
      ['x-d', long(2000)],
      ['x-e', long(2000)],
      ['x-f', long(2000)],
      ['x-g', long(2000)],
      ['x-h', long(1990)],
      ['x-i', long(1500)],
      ['cookie', `c1=${long(1800)}; c2=${long(100)}`],
    ],
    exclude: NONE,
  },
  {
    name: 'a repeated cookie forwards its first value',
    headers: [['cookie', 'dup=first; other=1; dup=second']],
    exclude: NONE,
  },
  {
    name: 'past 256 cookies the rest are dropped by name',
    headers: [
      ['cookie', Array.from({ length: 260 }, (_, i) => `k${String(i).padStart(3, '0')}=v`).join('; ')],
    ],
    exclude: NONE,
  },
  {
    name: 'past 128 drops the rest go unnamed',
    headers: Array.from({ length: 130 }, (_, i): [string, string] => [
      `x-h${String(i).padStart(3, '0')}`,
      long(2049),
    ]),
    exclude: NONE,
  },
  {
    name: 'our cookie spaced before its equals is still ours',
    headers: [['cookie', '__Host-d3person =x; noequals; =blank; keep=1']],
    exclude: NONE,
  },
  {
    name: 'a header named __proto__ is forwarded like any other',
    headers: [['__proto__', 'p']],
    exclude: NONE,
  },
];

function headersOf(pairs: Pairs): Headers {
  const h = new Headers();
  for (const [name, value] of pairs) h.append(name, value);
  return h;
}

const withheldCases: {
  name: string;
  exclude: ForwardExclusions;
  unlisted: { headers: boolean; cookies: boolean };
}[] = [
  { name: 'nothing kept back', exclude: NONE, unlisted: { headers: false, cookies: false } },
  {
    name: 'exclusions echoed',
    exclude: { headers: ['x-a'], cookies: ['c'] },
    unlisted: { headers: false, cookies: false },
  },
  { name: 'an unlisted drop flagged', exclude: NONE, unlisted: { headers: true, cookies: false } },
  {
    name: 'past 128 exclusions flagged',
    exclude: { headers: Array.from({ length: 130 }, (_, i) => `x-${i}`), cookies: [] },
    unlisted: { headers: false, cookies: false },
  },
];

interface McpCase {
  name: string;
  method: string;
  headers: Pairs;
  body: string;
  excluded?: string[];
  /** `@BLOB@` in the body stands for this many `x`, so a 1 MiB call ships as its size. */
  blobBytes?: number;
}

const call = (params: object, extra: object = { id: 7 }) =>
  JSON.stringify({ jsonrpc: '2.0', ...extra, method: 'tools/call', params });
const x402 = { x402Version: 2, payload: { signature: '0xabc', authorization: { value: '1000' } } };

const mcpCases: McpCase[] = [
  {
    name: 'x402 in _meta is lifted and stripped',
    method: 'POST',
    headers: [['content-type', 'application/json']],
    body: call({ name: 'search', arguments: { q: 'a' }, _meta: { 'x402/payment': x402, progressToken: 1 } }),
  },
  {
    name: 'the DNA key in _meta is lifted and _meta goes when empty',
    method: 'POST',
    headers: [['content-type', 'application/json; charset=utf-8']],
    body: call({ name: 'search', _meta: { 'dna.d3.com/key': 'dna_k_meta' } }),
  },
  {
    name: 'the key argument is lifted from a tool call',
    method: 'POST',
    headers: [['content-type', 'application/json']],
    body: call({ name: 'search', arguments: { q: 'a', dna_account_key: 'dna_k_arg' } }),
  },
  {
    name: 'the _meta key wins over the argument, and both are stripped',
    method: 'POST',
    headers: [['content-type', 'application/json']],
    body: call({ name: 's', arguments: { dna_account_key: 'arg' }, _meta: { 'dna.d3.com/key': 'meta' } }),
  },
  {
    name: 'a key argument outside a tool call stays',
    method: 'POST',
    headers: [['content-type', 'application/json']],
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'p1',
      method: 'prompts/get',
      params: { name: 'greet', arguments: { dna_account_key: 'k' } },
    }),
  },
  {
    name: 'the mirrored key header is lifted when the body carries none',
    method: 'POST',
    headers: [
      ['content-type', 'application/json'],
      ['mcp-param-dna-key', 'dna_k_header'],
    ],
    body: call({ name: 'search' }),
  },
  {
    name: 'a resource URI loses its query and userinfo in the facts',
    method: 'POST',
    headers: [['content-type', 'application/json']],
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'resources/read',
      params: { uri: 'https://user:pw@h.example/doc?token=1#x' },
    }),
  },
  {
    name: 'without a readable call the mirrors name it',
    method: 'GET',
    headers: [
      ['mcp-method', 'tools/call'],
      ['mcp-name', 'search'],
    ],
    body: '',
  },
  {
    name: 'an excluded mirror is not read',
    method: 'GET',
    headers: [
      ['mcp-method', 'tools/call'],
      ['mcp-name', 'search'],
    ],
    body: '',
    excluded: ['mcp-name'],
  },
  {
    name: 'a method past 128 chars or not printable is dropped',
    method: 'POST',
    headers: [['content-type', 'application/json']],
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: long(129, 'm'), params: { name: 'tab\there' } }),
  },
  {
    name: 'a batch is not a call',
    method: 'POST',
    headers: [['content-type', 'application/json']],
    body: JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'a' } }]),
  },
  {
    name: 'a notification keeps no id',
    method: 'POST',
    headers: [['content-type', 'application/json']],
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'a', _meta: { 'dna.d3.com/key': 'k' } },
    }),
  },
  {
    name: 'a null id stays null',
    method: 'POST',
    headers: [['content-type', 'application/json']],
    body: call({ name: 'a', _meta: { 'dna.d3.com/key': 'k' } }, { id: null }),
  },
  {
    name: 'a +json type is JSON',
    method: 'POST',
    headers: [['content-type', 'application/vnd.example+json']],
    body: call({ name: 'a', _meta: { 'dna.d3.com/key': 'k' } }),
  },
  {
    name: 'not JSON is not a call',
    method: 'POST',
    headers: [['content-type', 'application/json']],
    body: '{"jsonrpc":"2.0",',
  },
  {
    name: 'a non-object x402 payment is stripped and not lifted',
    method: 'POST',
    headers: [['content-type', 'application/json']],
    body: call({ name: 'a', _meta: { 'x402/payment': 'not-an-object', keep: true } }),
  },
  {
    name: 'a header credential wins over the body, family by family',
    method: 'POST',
    headers: [
      ['content-type', 'application/json'],
      ['x-payment', 'header-payment'],
    ],
    body: call({ name: 'a', _meta: { 'x402/payment': x402, 'dna.d3.com/key': 'k' } }),
  },
  {
    name: 'an oversized call naming a credential cannot be read',
    method: 'POST',
    headers: [['content-type', 'application/json']],
    body: call({ name: 'a', arguments: { blob: '@BLOB@' }, _meta: { 'dna.d3.com/key': 'k' } }),
    blobBytes: 1_048_576,
  },
  {
    name: 'an oversized call naming none is passed on',
    method: 'POST',
    headers: [['content-type', 'application/json']],
    body: call({ name: 'a', arguments: { blob: '@BLOB@' } }),
    blobBytes: 1_048_576,
  },
  {
    name: 'a batch naming a credential cannot be read',
    method: 'POST',
    headers: [['content-type', 'application/json']],
    body: JSON.stringify([
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'a', _meta: { 'dna.d3.com/key': 'k' } },
      },
    ]),
  },
  {
    name: 'a call sent as text/plain naming a credential cannot be read',
    method: 'POST',
    headers: [['content-type', 'text/plain']],
    body: call({ name: 'a', arguments: { dna_account_key: 'k' } }),
  },
  {
    name: 'a call sent as application/json-rpc naming a credential cannot be read',
    method: 'POST',
    headers: [['content-type', 'application/json-rpc']],
    body: call({ name: 'a', _meta: { 'x402/payment': x402 } }),
  },
  {
    name: 'a batch spelling the key with an escaped slash, as PHP does, cannot be read',
    method: 'POST',
    headers: [['content-type', 'application/json']],
    body: '[{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"_meta":{"dna.d3.com\\/key":"k","x402\\/payment":{}}}}]',
  },
  {
    name: 'an upload holding an example call is left alone',
    method: 'POST',
    headers: [['content-type', 'multipart/form-data; boundary=b']],
    body: `--b\r\ncontent-type: application/json\r\n\r\n${call({ name: 'a', _meta: { 'dna.d3.com/key': 'k' } })}\r\n--b--`,
  },
  {
    name: 'a document holding an example call is left alone',
    method: 'POST',
    headers: [['content-type', 'application/json']],
    body: JSON.stringify({
      openapi: '3.1.0',
      examples: { pay: JSON.parse(call({ name: 'a', _meta: { 'dna.d3.com/key': 'k' } })) },
    }),
  },
  {
    name: 'a JSON-RPC answer naming the key argument in a schema is left alone',
    method: 'POST',
    headers: [['content-type', 'application/json']],
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: { tools: [{ inputSchema: { properties: { dna_account_key: {} } } }] },
    }),
  },
  {
    name: 'a truncated batch naming a key falls back to the byte search',
    method: 'POST',
    headers: [['content-type', 'application/json']],
    body: '[{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"_meta":{"dna.d3.com/key":"k"}}',
  },
  {
    name: 'a truncated batch spelling the key as PHP does is found by the byte search',
    method: 'POST',
    headers: [['content-type', 'application/json']],
    body: '[{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"_meta":{"dna.d3.com\\/key":"k"}}',
  },
  {
    name: 'an oversized call spelling the key as PHP does cannot be read',
    method: 'POST',
    headers: [['content-type', 'application/json']],
    body: '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"blob":"@BLOB@","_meta":{"x402\\/payment":{}}}}',
    blobBytes: 1_048_576,
  },
  {
    name: 'a post that names a key but never says jsonrpc is left alone',
    method: 'POST',
    headers: [['content-type', 'application/json']],
    body: JSON.stringify({
      title: 'Paying over MCP',
      sample: { _meta: { 'x402/payment': {}, 'dna.d3.com/key': 'k' } },
    }),
  },
  {
    name: 'numbers keep their exact value through a rewrite',
    method: 'POST',
    headers: [['content-type', 'application/json']],
    body: call({
      name: 'a',
      arguments: { n: 0.30000000000000004, big: 9007199254740991, neg: -1.5e-7 },
      _meta: { 'dna.d3.com/key': 'k' },
    }),
  },
];

function mcpCase(c: McpCase) {
  const body = c.blobBytes === undefined ? c.body : c.body.replace('@BLOB@', long(c.blobBytes));
  const request = new Request('https://site.example/mcp', {
    method: c.method,
    headers: headersOf(c.headers),
    ...(c.method === 'GET' ? {} : { body }),
  });
  const bytes = new TextEncoder().encode(body).buffer;
  const carriage = mcpCarriageOf(request, bytes as ArrayBuffer, c.excluded ?? []);
  return {
    name: c.name,
    method: c.method,
    headers: c.headers,
    body: c.body,
    ...(c.blobBytes === undefined ? {} : { blobBytes: c.blobBytes }),
    excluded: c.excluded ?? [],
    rpc: carriage.rpc,
    facts: carriage.facts,
    lifted: carriage.lifted,
    originBody: carriage.originBody === null ? null : JSON.parse(carriage.originBody),
    unreadableCredential: carriage.unreadableCredential,
    unreadableReason: carriage.unreadableReason ?? null,
    forwarded: liftedPaymentToForward(request.headers, carriage.lifted),
  };
}

const answerCases: { name: string; payment: PaymentInstruction; rpcId?: string | number | null }[] = [
  {
    name: 'a 402 with its headers, unsafe ones dropped',
    payment: {
      status: 402,
      headers: {
        'payment-required': 'eyJ4fQ==',
        link: '<https://dna.d3.com/approve/h1>; rel="payment"',
        'x-bad': 'a\r\nset-cookie: evil=1',
        'bad name': 'v',
        'x-empty': '',
        'x-long': long(8193),
      },
      body: '{"error":"payment_required"}',
    },
  },
  {
    name: 'a redirect has no content type',
    payment: { status: 302, headers: { location: 'https://pay.example/a' } },
  },
  { name: 'pay copy is a 200', payment: { status: 200, body: '<p>copy</p>' } },
  {
    name: 'a json-rpc instruction answers with the call id',
    payment: {
      status: 402,
      bodyKind: 'json-rpc',
      body: '{"content":[{"type":"text","text":"pay"}],"isError":true}',
    },
    rpcId: 7,
  },
  {
    name: 'a json-rpc instruction keeps a string id',
    payment: { status: 402, bodyKind: 'json-rpc', body: '{"a":[]}', headers: { 'payment-required': 'x' } },
    rpcId: 'abc',
  },
  {
    name: 'a json-rpc instruction keeps a null id',
    payment: { status: 402, bodyKind: 'json-rpc', body: '{}' },
    rpcId: null,
  },
  {
    name: 'a json-rpc instruction whose body is not JSON fails closed',
    payment: { status: 402, bodyKind: 'json-rpc', body: 'not json' },
    rpcId: 1,
  },
  {
    name: 'a json-rpc instruction with no call is the plain answer',
    payment: { status: 402, bodyKind: 'json-rpc', body: '{"x":1}' },
  },
];

async function answerCase(c: (typeof answerCases)[number]) {
  const mode = paymentEdgeMode(c.payment.status ?? 502);
  const response = buildPaymentResponse(c.payment, mode, c.rpcId);
  const text = await response.text();
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => (headers[name] = value));
  return {
    name: c.name,
    payment: c.payment,
    ...(c.rpcId === undefined ? {} : { rpcId: c.rpcId }),
    status: response.status,
    headers,
    body: text === '' ? null : text,
  };
}

const resultCases: {
  name: string;
  body: string;
  contentType: string;
  meta?: Record<string, unknown>;
  method?: string;
  keyArgument: boolean;
}[] = [
  {
    name: 'the receipt goes into _meta',
    body: '{"jsonrpc":"2.0","id":7,"result":{"content":[],"_meta":{"origin":1}}}',
    contentType: 'application/json',
    meta: { 'x402/payment-response': { success: true } },
    method: 'tools/call',
    keyArgument: false,
  },
  {
    name: 'tools/list gains the key argument',
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: {
        tools: [
          { name: 'a', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } },
          { name: 'b' },
          'odd',
        ],
      },
    }),
    contentType: 'application/json',
    method: 'tools/list',
    keyArgument: true,
  },
  {
    name: 'an error answer is left alone',
    body: '{"jsonrpc":"2.0","id":7,"error":{"code":-1,"message":"no"}}',
    contentType: 'application/json',
    meta: { r: 1 },
    method: 'tools/call',
    keyArgument: false,
  },
  {
    name: 'an event stream is left alone',
    body: 'event: message\ndata: {"jsonrpc":"2.0","id":7,"result":{}}\n\n',
    contentType: 'text/event-stream',
    meta: { r: 1 },
    method: 'tools/call',
    keyArgument: false,
  },
  {
    name: 'a body that is not JSON is left alone',
    body: '{"jsonrpc":"2.0",',
    contentType: 'application/json',
    meta: { r: 1 },
    method: 'tools/call',
    keyArgument: false,
  },
  {
    name: 'no edits, no rewrite',
    body: '{"jsonrpc":"2.0","id":7,"result":{}}',
    contentType: 'application/json',
    method: 'tools/call',
    keyArgument: false,
  },
  {
    name: 'numbers and empty arrays survive the rewrite',
    body: '{"jsonrpc":"2.0","id":9007199254740991,"result":{"n":0.30000000000000004,"e":[],"o":{},"s":"a/b\\u0001\\"q"}}',
    contentType: 'application/json',
    meta: { r: 1 },
    method: 'tools/call',
    keyArgument: false,
  },
];

async function resultCase(c: (typeof resultCases)[number]) {
  const response = new Response(c.body, { headers: { 'content-type': c.contentType, etag: '"v1"' } });
  const out = await withMcpResult(response, { method: c.method, meta: c.meta, keyArgument: c.keyArgument });
  const text = await out.text();
  return {
    name: c.name,
    body: c.body,
    contentType: c.contentType,
    meta: c.meta ?? null,
    method: c.method ?? null,
    keyArgument: c.keyArgument,
    rewritten: text === c.body && out.headers.get('etag') !== null ? null : JSON.parse(text),
  };
}

const settingsCases: { name: string; env: Record<string, string> }[] = [
  { name: 'nothing set is off', env: {} },
  { name: 'DNA_API_KEY alone is on, at the default endpoint', env: { DNA_API_KEY: 'k' } },
  { name: 'an earlier key alone stays off', env: { POLICY_ADAPTER_KEY: 'k' } },
  { name: 'an empty endpoint is off', env: { DNA_API_KEY: 'k', DNA_ENDPOINT: '' } },
  { name: 'DNA_ENABLED false is off', env: { DNA_API_KEY: 'k', DNA_ENABLED: ' FALSE ' } },
  {
    name: 'every setting, read',
    env: {
      DNA_API_KEY: 'k',
      DNA_ENDPOINT: 'http://127.0.0.1:9000/v1/decision',
      DNA_FAIL_MODE: 'closed',
      DNA_TIMEOUT_MS: '300',
      DNA_PAYMENT_TIMEOUT_MS: '9000',
      DNA_DEBUG_LOG_RAW_PAYLOAD: 'true',
      DNA_EXCLUDE_HEADERS: ' X-Internal , x-internal,,x-two ',
      DNA_EXCLUDE_COOKIES: 'Sid, sid',
    },
  },
  {
    name: 'a bad timeout falls back',
    env: { DNA_API_KEY: 'k', DNA_TIMEOUT_MS: '-5', DNA_PAYMENT_TIMEOUT_MS: 'soon' },
  },
  {
    name: 'earlier names still read, and the generic debug name only beside POLICY_WORKER_URL',
    env: {
      POLICY_WORKER_URL: 'https://edge.example/v1/decision',
      POLICY_SHARED_SECRET: 's',
      FAIL_MODE: 'closed',
      POLICY_TIMEOUT_MS: '250',
      DEBUG_LOG_RAW_PAYLOAD: 'true',
    },
  },
  {
    name: 'the generic debug name alone is ignored',
    env: { DNA_API_KEY: 'k', DEBUG_LOG_RAW_PAYLOAD: 'true' },
  },
  {
    name: 'a DNA_ name wins over an earlier one',
    env: { DNA_API_KEY: 'new', POLICY_ADAPTER_KEY: 'old', DNA_FAIL_MODE: 'open', FAIL_MODE: 'closed' },
  },
];

export async function buildParity() {
  return {
    constants: {
      ADAPTER_SET,
      FORWARDED_HEADER_SET,
      FORWARDED_HEADERS,
      HEADER_LENGTH_CAPS: Object.fromEntries(HEADER_LENGTH_CAPS),
      NEVER_FORWARDED_HEADERS: [...NEVER_FORWARDED_HEADERS],
      MCP_KEY_ARGUMENT_SCHEMA,
    },
    forwardAll: forwardAllCases.map((c) => ({
      ...c,
      out: forwardAll(headersOf(c.headers), c.exclude, HEADER_LENGTH_CAPS),
    })),
    withheld: withheldCases.map((c) => ({ ...c, out: withheldOf(c.exclude, c.unlisted) })),
    exclusionList: [' A, b ,,a ', '', undefined, 'Sid,sid, Sid '].flatMap((raw) =>
      [true, false].map((lowercase) => ({
        raw: raw ?? null,
        lowercase,
        out: parseExclusionList(raw, { lowercase }),
      }))
    ),
    privateCacheControl: [
      'public, s-maxage=60, stale-while-revalidate=300',
      'max-age=60',
      'private, max-age=60',
      'no-store',
      null,
      '',
      ' , ',
      'max-age=0, must-revalidate, public',
      'private="set-cookie", max-age=5',
      'no-cache',
      'public, max-age=60, public',
      'PUBLIC, max-age=1',
      'No-Store',
    ].map((origin) => ({ origin, out: privateCacheControl(origin) })),
    cookies: [
      'a=1; b = 2 ;c=; =x; noeq; d=e=f',
      '',
      '__Host-d3pay=S; __Host-d3person =P; site=1',
      '__Secure-d3visitor=V; site=1',
      '__Host-d3_acquisition=keep; __Secure-d3-admin.session_token=keep; site=1',
      '__Secure-d3visitor; site=1',
      '__Host-d3pay =S; site=1',
    ].map((header) => ({
      header,
      cookiesOf: cookiesOf(header),
      readSession: readCookie(header, '__Host-d3pay'),
      readPerson: readCookie(header, '__Host-d3person'),
      stripOwn: header === '' ? null : stripOwnCookies(header),
    })),
    payParams: [
      '/a',
      '/a?x=1',
      `/a?d3pay_handoff=${handoff}&x=1`,
      '/a?x=1&d3pay_check=1&d3pay_browser=abc&y=%2F',
      '/a?d3pay_handoff=1',
      '/a?d3pay_handoffx=1&d3pay_handoff',
      '/a?d3pay%5Flater%FF=secret&keep=1',
      '/a?d3pay%5Fcheck=1&keep=2',
    ].map((url) => ({ url, out: stripPayParams(url) })),
    mcp: mcpCases.map(mcpCase),
    answers: await Promise.all(answerCases.map(answerCase)),
    results: await Promise.all(resultCases.map(resultCase)),
    edgeModes: [402, 302, 307, 200, 500, 502, 403].map((status) => ({
      status,
      out: paymentEdgeMode(status),
    })),
    recordableName: ['search', 'https://u:p@h/x?t=1', 'file:///a#b', 'urn:x?y', ''].map((name) => ({
      name,
      out: recordableName(name) ?? null,
    })),
    debugHeaders: [
      {
        name: 'the never-sent and excluded go, and each value is bounded',
        headers: [
          ['authorization', 'a'],
          ['x-keep', 'k'],
          ['x-excluded', 'e'],
          ['x-long', long(2049)],
          ['cookie', 'c=1'],
        ] as Pairs,
        excluded: ['x-excluded'],
      },
      {
        name: 'at most 64',
        headers: Array.from({ length: 70 }, (_, i): [string, string] => [
          `x-${String(i).padStart(2, '0')}`,
          'v',
        ]),
        excluded: [],
      },
    ].map((c) => ({ ...c, out: debugHeadersOf([...headersOf(c.headers).entries()], c.excluded) })),
    exclusionOverflow: [
      { headers: [], cookies: [] },
      { headers: names(128), cookies: names(128) },
      { headers: names(129), cookies: [] },
      { headers: names(200), cookies: names(130) },
    ].map((exclude) => ({ exclude, out: exclusionOverflowWarning(exclude) ?? null })),
    unreadableAnswers: await Promise.all(
      (['too-large', 'not-one-call'] as const).map(async (reason) => {
        const response = unreadableCallResponse(reason);
        const headers: Record<string, string> = {};
        response.headers.forEach((value, name) => (headers[name] = value));
        return { reason, status: response.status, headers, body: await response.text() };
      })
    ),
    settings: settingsCases.map((c) => ({ ...c, out: readAdapterSettings((name) => c.env[name]) })),
  };
}
