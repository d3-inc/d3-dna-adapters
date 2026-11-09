import { MCP_KEY_ARGUMENT, type UnreadableReason } from './mcp';
import { privateCacheControl } from './payment-response';

/** How long a host's `mcpKeyArgument` holds after the decision that carried it (ADR 0081 decision 4). */
export const MCP_KEY_ARGUMENT_MEMORY_MS = 5 * 60_000;

/** The fleet fronts many hosts in one isolate; past this the oldest is forgotten, which only drops an argument. */
const MCP_KEY_ARGUMENT_MAX_HOSTS = 10_000;

/** Larger results pass untouched: rewriting one means holding it whole in the isolate. */
export const MCP_RESULT_MAX_BYTES = 4 * 1_048_576;

/** The tool argument a language-model client can fill; `x-mcp-header` asks a conforming client to mirror it (SEP-2243). */
export const MCP_KEY_ARGUMENT_SCHEMA = {
  type: 'string',
  description: 'A DNA account key that pays for this call. Leave it out to be told how to pay.',
  'x-mcp-header': 'Dna-Key',
} as const;

/** They describe the origin's bytes, which a rewrite changes: a digest or validator left on would be wrong. */
const REPRESENTATION_HEADERS = ['content-length', 'content-digest', 'repr-digest', 'content-md5', 'etag'];

/**
 * The answer to an MCP call the adapter did not read that names one of our
 * credentials: it can neither strip it nor let the origin see it. A call it
 * could not read as one call gets the worker's own answer for one.
 */
export function unreadableCallResponse(reason: UnreadableReason = 'too-large'): Response {
  const tooLarge = reason === 'too-large';
  const body = tooLarge
    ? { error: 'mcp_call_too_large' }
    : { error: 'mcp_call_unreadable', detail: 'Send one JSON-RPC request per call, as application/json.' };
  return new Response(JSON.stringify(body), {
    status: tooLarge ? 413 : 400,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-d3-edge': 'fail-closed',
    },
  });
}

/** Per isolate: whether each host's site turned the key argument on, as the last decision said. */
export class McpKeyArgumentMemory {
  private readonly untilByHost = new Map<string, number>();

  remember(host: string, on: boolean, nowMs = Date.now()): void {
    this.untilByHost.delete(host);
    if (!on) return;

    if (this.untilByHost.size >= MCP_KEY_ARGUMENT_MAX_HOSTS) {
      const oldest = this.untilByHost.keys().next().value;
      if (oldest !== undefined) this.untilByHost.delete(oldest);
    }

    this.untilByHost.set(host, nowMs + MCP_KEY_ARGUMENT_MEMORY_MS);
  }

  isOn(host: string, nowMs = Date.now()): boolean {
    const until = this.untilByHost.get(host);
    return until !== undefined && nowMs < until;
  }
}

export interface McpResultEdits {
  /** The call's JSON-RPC method. */
  method?: string;
  /** Added to the result's `_meta`: the receipt of a paid call. */
  meta?: Record<string, unknown>;
  /** Add the key argument to every tool in a `tools/list` result. */
  keyArgument: boolean;
}

/**
 * The origin's JSON-RPC answer with our `_meta` and, on `tools/list`, the key
 * argument. Anything else passes untouched: an event stream, an error, a body
 * that is not one JSON-RPC response, or one past the size cap.
 */
export async function withMcpResult(response: Response, edits: McpResultEdits): Promise<Response> {
  const meta = edits.meta && Object.keys(edits.meta).length > 0 ? edits.meta : null;
  const listsTools = edits.keyArgument && edits.method === 'tools/list';
  if ((!meta && !listsTools) || !isJsonResponse(response) || response.body === null) return response;

  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MCP_RESULT_MAX_BYTES) return response;

  const read = await readUpTo(response.body, MCP_RESULT_MAX_BYTES);
  const rewritten =
    read.rest === null ? rewriteResult(concat(read.chunks, read.bytes), meta, listsTools) : null;
  if (rewritten === null) return new Response(passThrough(read), response);

  const headers = new Headers(response.headers);
  for (const name of REPRESENTATION_HEADERS) headers.delete(name);
  // A receipt is one payer's: no shared cache may hold it, whether or not the instruction carried headers too.
  if (meta) headers.set('cache-control', privateCacheControl(headers.get('cache-control')));
  return new Response(rewritten, { status: response.status, statusText: response.statusText, headers });
}

interface BoundedRead {
  /** As read, never joined past the cap. */
  chunks: Uint8Array[];
  bytes: number;
  /** The unread remainder once the cap was passed; null when the whole body fit. */
  rest: ReadableStreamDefaultReader<Uint8Array> | null;
}

/** Holds at most `cap` bytes joined: the chunk that passes it is kept as it came, and the rest streams on. */
async function readUpTo(body: ReadableStream<Uint8Array>, cap: number): Promise<BoundedRead> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { chunks, bytes, rest: null };

    chunks.push(value);
    bytes += value.byteLength;
    if (bytes > cap) return { chunks, bytes, rest: reader };
  }
}

/** The origin's bytes exactly as they came, then whatever was left unread. */
function passThrough({ chunks, rest }: BoundedRead): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      if (rest === null) controller.close();
    },
    async pull(controller) {
      if (rest === null) return;

      const { done, value } = await rest.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) {
      return rest?.cancel(reason);
    },
  });
}

function concat(chunks: Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }

  return out;
}

function rewriteResult(
  bytes: Uint8Array,
  meta: Record<string, unknown> | null,
  listsTools: boolean
): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    return null;
  }

  if (!isRecord(parsed) || parsed.jsonrpc !== '2.0' || !isRecord(parsed.result)) return null;

  const result: Record<string, unknown> = { ...parsed.result };
  if (meta) result._meta = { ...(isRecord(result._meta) ? result._meta : {}), ...meta };

  if (listsTools && Array.isArray(result.tools)) result.tools = result.tools.map(withKeyArgument);

  return JSON.stringify({ ...parsed, result });
}

function withKeyArgument(tool: unknown): unknown {
  if (!isRecord(tool)) return tool;

  const schema = isRecord(tool.inputSchema) ? tool.inputSchema : { type: 'object' };
  const properties = isRecord(schema.properties) ? schema.properties : {};
  return {
    ...tool,
    inputSchema: { ...schema, properties: { ...properties, [MCP_KEY_ARGUMENT]: MCP_KEY_ARGUMENT_SCHEMA } },
  };
}

function isJsonResponse(response: Response): boolean {
  const type = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  return type === 'application/json' || type.endsWith('+json');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
