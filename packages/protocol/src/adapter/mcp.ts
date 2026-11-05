import { PAYMENT_AUTHORIZATION_HEADER } from '../pay-session';
import type { RequestPayload } from '../types';
import { base64Utf8, X402_PAYMENT_HEADER_V2, X402_PAYMENT_HEADERS } from '../x402/payment-header';
import { MCP_DNA_KEY_HEADER, MCP_METHOD_HEADER, MCP_NAME_HEADER } from './forwarding.constants';

export const MCP_KEY_ARGUMENT = 'dna_account_key';

/** `_meta` keys: x402's MCP binding, and ours, named under the prefix MCP asks custom keys to carry. */
export const MCP_X402_PAYMENT_META = 'x402/payment';

export const MCP_DNA_KEY_META = 'dna.d3.com/key';

/** Larger bodies are not read as a call: parsing them at the adapter costs every POST. */
export const MCP_BODY_MAX_BYTES = 1_048_576;

const MCP_METHOD_MAX_LENGTH = 128;

const MCP_NAME_MAX_LENGTH = 256;

const PRINTABLE = /^[\x20-\x7e]+$/;

export interface JsonRpcRequest {
  /** Absent on a notification. */
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

/** `body` when the adapter read the call itself; `headers` when only the client's `Mcp-*` mirrors named it. */
export type McpFactsSource = 'body' | 'headers';

export interface McpFacts {
  method?: string;
  tool?: string;
  source: McpFactsSource;
}

export interface McpCarriage {
  rpc: JsonRpcRequest | null;
  /** Null when neither the body nor the mirrors name a call. */
  facts: McpFacts | null;
  /** Payment headers lifted from the body, for the decision only. */
  lifted: Record<string, string>;
  /** The body the origin gets in place of the client's; null when nothing was taken out of it. */
  originBody: string | null;
  /** Too large to read, yet naming one of our credentials: it cannot be stripped, so it must not reach the origin. */
  unreadableCredential: boolean;
}

/** One JSON-RPC request in a JSON POST body; null for a batch, a response, a notification without a method, or anything else. */
export function readJsonRpcRequest(
  method: string,
  contentType: string | null,
  body: ArrayBuffer
): JsonRpcRequest | null {
  if (method !== 'POST' || !isJsonType(contentType)) return null;

  if (body.byteLength === 0 || body.byteLength > MCP_BODY_MAX_BYTES) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return null;
  }

  if (!isRecord(parsed) || parsed.jsonrpc !== '2.0' || typeof parsed.method !== 'string') return null;

  const id = parsed.id;
  if (id !== undefined && id !== null && typeof id !== 'string' && typeof id !== 'number') return null;

  return {
    ...(id === undefined ? {} : { id }),
    method: parsed.method,
    ...(isRecord(parsed.params) ? { params: parsed.params } : {}),
  };
}

/** Each `_meta` key and the argument that can carry a credential, as the JSON names them. */
const CREDENTIAL_KEYS: readonly Uint8Array[] = [
  MCP_X402_PAYMENT_META,
  MCP_DNA_KEY_META,
  MCP_KEY_ARGUMENT,
].map((key) => new TextEncoder().encode(JSON.stringify(key)));

/**
 * A JSON POST past `MCP_BODY_MAX_BYTES` whose bytes name a credential key. A
 * byte search, not a parse, so the cost the cap avoids stays avoided; a key
 * hidden behind JSON escapes is the client hiding its own credential.
 */
export function oversizedCallNamesCredential(
  method: string,
  contentType: string | null,
  body: ArrayBuffer
): boolean {
  if (method !== 'POST' || !isJsonType(contentType) || body.byteLength <= MCP_BODY_MAX_BYTES) return false;

  const bytes = new Uint8Array(body);
  return CREDENTIAL_KEYS.some((key) => includesBytes(bytes, key));
}

function includesBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  const last = haystack.length - needle.length;
  for (
    let at = haystack.indexOf(needle[0]);
    at !== -1 && at <= last;
    at = haystack.indexOf(needle[0], at + 1)
  ) {
    let i = 1;
    while (i < needle.length && haystack[at + i] === needle[i]) i += 1;
    if (i === needle.length) return true;
  }

  return false;
}

function isJsonType(contentType: string | null): boolean {
  const type = (contentType ?? '').split(';')[0].trim().toLowerCase();
  return type === 'application/json' || type.endsWith('+json');
}

/**
 * The body when the adapter read one call, the mirrors otherwise, never a mix:
 * the body is what the origin executes, and a header the client set is only its
 * claim, so `source` says which the worker is reading.
 */
export function mcpFactsOf(
  headers: Headers,
  rpc: JsonRpcRequest | null,
  excluded: readonly string[] = []
): McpFacts | null {
  const mirror = (name: string) => (excluded.includes(name) ? null : headers.get(name));
  const method = rpc
    ? bounded(rpc.method, MCP_METHOD_MAX_LENGTH)
    : bounded(mirror(MCP_METHOD_HEADER), MCP_METHOD_MAX_LENGTH);
  const tool = rpc
    ? bounded(nameInCall(rpc), MCP_NAME_MAX_LENGTH)
    : bounded(recordableName(mirror(MCP_NAME_HEADER) ?? undefined), MCP_NAME_MAX_LENGTH);
  if (!method && !tool) return null;

  return { ...(method ? { method } : {}), ...(tool ? { tool } : {}), source: rpc ? 'body' : 'headers' };
}

/** The tool, prompt or resource a call names, where SEP-2243 mirrors one into `Mcp-Name`. */
function nameInCall(rpc: JsonRpcRequest | null): string | undefined {
  const params = rpc?.params;
  if (!params) return undefined;

  if (rpc.method === 'resources/read') return recordableName(stringOrUndefined(params.uri));

  return rpc.method === 'tools/call' || rpc.method === 'prompts/get'
    ? stringOrUndefined(params.name)
    : undefined;
}

/**
 * A resource URI can carry a token in its query or a password before the host,
 * and `Mcp-Name` may name one too; the record keeps neither. A tool's name has
 * neither, so it passes unchanged.
 */
export function recordableName(name: string | undefined): string | undefined {
  if (!name) return undefined;

  return name.split(/[?#]/)[0].replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, '$1');
}

function bounded(value: string | null | undefined, max: number): string | undefined {
  return value && value.length <= max && PRINTABLE.test(value) ? value : undefined;
}

/**
 * The call's payment as the headers the worker already reads, and the body
 * without it for the origin. The key argument is lifted whether or not the
 * site offers it: an isolate that has not yet heard the site's switch must
 * still never hand the origin a buyer's key.
 */
export function liftMcpPayment(rpc: JsonRpcRequest): Pick<McpCarriage, 'lifted' | 'originBody'> {
  const params = rpc.params;
  if (!params) return { lifted: {}, originBody: null };

  const lifted: Record<string, string> = {};
  const meta = isRecord(params._meta) ? { ...params._meta } : null;
  const args = isRecord(params.arguments) ? { ...params.arguments } : null;
  let changed = false;

  if (meta && MCP_X402_PAYMENT_META in meta) {
    const payment = meta[MCP_X402_PAYMENT_META];
    if (isRecord(payment)) lifted[X402_PAYMENT_HEADER_V2] = base64Utf8(JSON.stringify(payment));

    delete meta[MCP_X402_PAYMENT_META];
    changed = true;
  }

  if (meta && MCP_DNA_KEY_META in meta) {
    const key = stringOrUndefined(meta[MCP_DNA_KEY_META]);
    if (key) lifted[PAYMENT_AUTHORIZATION_HEADER] = `Payment ${key}`;

    delete meta[MCP_DNA_KEY_META];
    changed = true;
  }

  if (rpc.method === 'tools/call' && args && MCP_KEY_ARGUMENT in args) {
    const key = stringOrUndefined(args[MCP_KEY_ARGUMENT]);
    if (key && !(PAYMENT_AUTHORIZATION_HEADER in lifted)) {
      lifted[PAYMENT_AUTHORIZATION_HEADER] = `Payment ${key}`;
    }

    delete args[MCP_KEY_ARGUMENT];
    changed = true;
  }

  if (!changed) return { lifted, originBody: null };

  const { _meta: _droppedMeta, arguments: _droppedArgs, ...rest } = params;
  const originParams = {
    ...rest,
    ...(args ? { arguments: args } : {}),
    ...(meta && Object.keys(meta).length > 0 ? { _meta: meta } : {}),
  };
  return {
    lifted,
    originBody: JSON.stringify({ jsonrpc: '2.0', ...idPart(rpc), method: rpc.method, params: originParams }),
  };
}

function idPart(rpc: JsonRpcRequest): { id?: string | number | null } {
  return rpc.id === undefined ? {} : { id: rpc.id };
}

/** Everything revision 3 reads off a request: the call, its facts, and the payment it carries. */
export function mcpCarriageOf(
  request: Request,
  body: ArrayBuffer,
  excluded: readonly string[] = []
): McpCarriage {
  const rpc = readJsonRpcRequest(request.method, request.headers.get('content-type'), body);
  const facts = mcpFactsOf(request.headers, rpc, excluded);
  const { lifted, originBody } = rpc ? liftMcpPayment(rpc) : { lifted: {}, originBody: null };

  const mirrored = stringOrUndefined(request.headers.get(MCP_DNA_KEY_HEADER));
  if (mirrored && !(PAYMENT_AUTHORIZATION_HEADER in lifted)) {
    lifted[PAYMENT_AUTHORIZATION_HEADER] = `Payment ${mirrored}`;
  }

  const unreadableCredential = oversizedCallNamesCredential(
    request.method,
    request.headers.get('content-type'),
    body
  );
  return { rpc, facts, lifted, originBody, unreadableCredential };
}

/**
 * The request the origin gets: the call without its lifted payment. The length
 * and the client's digest go, since the body changed; the class, the abort
 * signal and the platform's metadata stay, so a framework's own request type
 * reaches its handler.
 */
export function mcpOriginRequest<R extends Request>(request: R, carriage: McpCarriage | null): R {
  const originBody = carriage?.originBody ?? null;
  if (originBody === null) return request;

  const headers = new Headers(request.headers);
  headers.delete('content-length');
  headers.delete('content-digest');
  // From the request itself, not its URL: the platform's own facts (Cloudflare's `cf`) ride it.
  const Same = request.constructor as new (input: Request, init: RequestInit) => R;
  return new Same(request, { headers, body: originBody });
}

/** What the record keeps of an MCP call: the adapter's reading, else the mirrors a revision 2 adapter forwards as plain headers. */
export function recordedMcpCall(payload: Pick<RequestPayload, 'mcp' | 'headers'>): {
  method?: string;
  tool?: string;
} {
  if (payload.mcp) return { method: payload.mcp.method, tool: recordableName(payload.mcp.tool) };

  const method = bounded(payload.headers[MCP_METHOD_HEADER], MCP_METHOD_MAX_LENGTH);
  const tool = bounded(recordableName(payload.headers[MCP_NAME_HEADER]), MCP_NAME_MAX_LENGTH);
  return { ...(method ? { method } : {}), ...(tool ? { tool } : {}) };
}

/** Payment credentials by family: the two x402 names are one, so a header of either keeps the body's x402 out. */
const PAYMENT_FAMILIES: readonly (readonly string[])[] = [
  X402_PAYMENT_HEADERS,
  [PAYMENT_AUTHORIZATION_HEADER],
];

/**
 * The lifted headers the decision takes: a credential the client sent as a
 * header wins over one in the body, family by family, so an empty or forged
 * `_meta` payment can never displace a valid header.
 */
export function liftedPaymentToForward(
  sent: Headers,
  lifted: Record<string, string>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const family of PAYMENT_FAMILIES) {
    if (family.some((name) => sent.has(name))) continue;

    for (const name of family) if (name in lifted) out[name] = lifted[name];
  }

  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
