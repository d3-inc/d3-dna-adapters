// The origin both proxy suites (caddy/test, openresty/test) put behind DNA. It
// echoes what reached it, and authors its own Set-Cookie, CORS list and caching
// so a suite can see ours are appended and its are kept. ORIGIN_PORT moves it.
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';

const json = (res, status, headers, body) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};

/** An MCP server's answer to a JSON-RPC call: a result, or the tools it lists. */
function mcpAnswer(req, res, text) {
  let call;
  try {
    call = JSON.parse(text);
  } catch {
    return json(res, 400, {}, { error: 'not json' });
  }

  const result =
    call.method === 'tools/list'
      ? {
          tools: [{ name: 'search', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } }],
        }
      : { content: [{ type: 'text', text: 'ok' }], echo: call.params ?? null };
  const answer = JSON.stringify({ jsonrpc: '2.0', id: call.id ?? null, result });

  if (req.url.startsWith('/mcp-sse')) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    return res.end(`event: message\ndata: ${answer}\n\n`);
  }

  const headers = { 'content-type': 'application/json', etag: '"v1"', 'cache-control': 'public, max-age=60' };
  if (req.url.startsWith('/mcp-gzip') && /\bgzip\b/.test(req.headers['accept-encoding'] ?? '')) {
    const zipped = gzipSync(answer);
    res.writeHead(200, { ...headers, 'content-encoding': 'gzip', 'content-length': zipped.length });
    return res.end(zipped);
  }

  res.writeHead(200, { ...headers, 'content-length': Buffer.byteLength(answer) });
  return res.end(answer);
}

createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    // Past every proxy buffer at once, then the rest later: a buffering proxy shows no first byte until the end.
    if (req.url === '/stream') {
      res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'public, max-age=60' });
      res.write('x'.repeat(256 * 1024));
      setTimeout(() => res.end('done'), 1500);
      return;
    }

    if (req.url.startsWith('/mcp')) return mcpAnswer(req, res, raw.toString('utf8'));

    const cc = req.headers['x-test-origin-cc'] ?? 'public, max-age=60';
    const own = req.headers['x-test-origin-receipt'];
    res.writeHead(200, {
      'content-type': 'application/json',
      ...(cc === '(absent)' ? {} : { 'cache-control': cc }),
      ...(own ? { 'payment-receipt': own } : {}),
      'set-cookie': 'site_session=KEEP; Path=/',
      'access-control-expose-headers': 'x-site-thing',
    });
    res.end(
      JSON.stringify({
        origin: true,
        url: req.url,
        method: req.method,
        headers: req.headers,
        bodyBytes: raw.length,
        body: raw.length <= 65536 ? raw.toString('utf8') : null,
      })
    );
  });
}).listen(Number(process.env.ORIGIN_PORT ?? 3000), '127.0.0.1');
