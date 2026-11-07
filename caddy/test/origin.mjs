// Echoes what reached it, and authors its own Set-Cookie, CORS list and caching
// so the test can see ours are appended and its are kept.
import { createServer } from 'node:http';
createServer((req, res) => {
  let bodyBytes = 0;
  req.on('data', (c) => {
    bodyBytes += c.length;
  });
  req.on('end', () => {
    // Past every proxy buffer at once, then the rest later: a buffering proxy shows no first byte until the end.
    if (req.url === '/stream') {
      res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'public, max-age=60' });
      res.write('x'.repeat(256 * 1024));
      setTimeout(() => res.end('done'), 1500);
      return;
    }

    const cc = req.headers['x-test-origin-cc'] ?? 'public, max-age=60';
    res.writeHead(200, {
      'content-type': 'application/json',
      ...(cc === '(absent)' ? {} : { 'cache-control': cc }),
      'set-cookie': 'site_session=KEEP; Path=/',
      'access-control-expose-headers': 'x-site-thing',
    });
    res.end(JSON.stringify({ origin: true, url: req.url, headers: req.headers, bodyBytes }));
  });
}).listen(3000, '127.0.0.1');
