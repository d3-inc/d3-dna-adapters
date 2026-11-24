# DNA for WordPress

[DNA](https://ai.d3.com) as a WordPress plugin. Per request it asks DNA for a
decision before WordPress runs, then serves the page, a `403`, or the rule's
own answer: a `402` with a price, a redirect to pay, or payment instructions
in place of the page. If DNA errors or is slow, your site serves as usual,
except to a visitor who is paying.

Every rule works, as on Cloudflare: any header or cookie, **Charge** and
**Require a human**, DNA's check page for browsers, and MCP tool calls charged
per call. On PHP-FPM and LiteSpeed it also reports what WordPress answered.

On a pass that carries DNA's verdict, WordPress gets it as
`$_SERVER['HTTP_X_D3_TIER']` and `$_SERVER['HTTP_X_D3_IDENTITY']`. A visitor's
own copies never reach `$_SERVER`.

## What it covers

DNA runs in PHP, so it sees what PHP serves.

| Request                                                                                                                                                                | Checked                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Pages, the REST API, `wp-admin`, `wp-login.php`, feeds                                                                                                                 | Yes                                             |
| A page-cache plugin's hit served by PHP (WP Super Cache, W3 Total Cache…)                                                                                              | Only with the `wp-config.php` line (Install, 3) |
| Files your web server sends itself: images, CSS, JS, uploads, and cached pages a cache plugin's rewrite rules serve as files (WP Rocket, WP Super Cache's expert mode) | No: they never reach PHP                        |
| Pages your host caches in front of PHP (WP Engine, Kinsta, Cloudflare APO)                                                                                             | No                                              |

A paid page is never stored by a page-cache plugin: DNA sets `DONOTCACHEPAGE`
on it, which they all honour. For the last two rows, put DNA in front of your
site instead:
[Cloudflare](../packages/cloudflare-adapter), or
[nginx](../openresty) if you run your own server.

WordPress's own requests are decided like a visitor's: `wp-cron.php`, Site
Health's loopback, a payment provider's webhook. A rule that blocks agents DNA
can't name blocks those too, so scope it to the paths it is for.

WordPress also serves a page at URLs a rule on its path doesn't name:
`/?rest_route=/x` for `/wp-json/x`, the path in other letter cases, its feed,
its embed, and the REST API's posts endpoints. A rule covers the URLs it
matches, so match each form a priced page is served under, or turn off the
ones your site doesn't use.

Behind a CDN or load balancer, DNA sees what PHP sees: set your server's
real-IP module, and `HTTPS` above the include line in `wp-config.php`, so
`REMOTE_ADDR` and `HTTPS` are the visitor's.

## Requirements

- WordPress 6.0 or later, PHP 7.4 or later, with the `curl` extension. Without
  curl every request is handled as if DNA couldn't be reached, so
  `DNA_FAIL_MODE` applies, and the status screen says curl is missing.

## Install

1. Download
   [`d3-dna.zip`](https://github.com/d3-inc/d3-dna-adapters/releases/latest/download/d3-dna.zip)
   and upload it under **Plugins → Add New → Upload Plugin**. Its build
   provenance checks with
   `gh attestation verify d3-dna.zip --repo d3-inc/d3-dna-adapters`.
2. Activate **DNA by D3**. It runs from then on, as a must-use plugin it
   installs, before your other plugins load. On a multisite network, activate
   it for the network: activated on one site, it runs there alone, after the
   must-use plugins.
3. In `wp-config.php`, above the line that requires `wp-settings.php`, set
   your key from [dashboard.d3.com/keys](https://dashboard.d3.com/keys), the
   domains your site serves, and run DNA before any page cache:
   ```php
   define('DNA_API_KEY', 'your key');
   define('DNA_HOSTS', 'www.example.com,example.com');
   if (is_file(__DIR__ . '/wp-content/plugins/d3-dna/boot.php')) include __DIR__ . '/wp-content/plugins/d3-dna/boot.php';
   ```
   If your `wp-content` lives elsewhere, **Tools → DNA** shows the line with
   your path. The `is_file` guard keeps your site up while WordPress replaces
   the plugin's files during an update.

Check it under **Tools → DNA**: **Check the home page** fetches it and reads
`x-d3-edge`. Or run `curl -sI https://www.example.com/`.

| You see              | It means                                                                                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pass`               | DNA is live.                                                                                                                                                                    |
| `disabled`           | DNA is off: `DNA_ENABLED` is `false`, or `DNA_API_KEY` is not set where PHP can see it.                                                                                         |
| `fail-open`          | DNA can't be reached, or PHP has no curl. The PHP error log says which.                                                                                                         |
| `block`, `payment-*` | DNA is live; a rule answered that page itself.                                                                                                                                  |
| `fail-closed`        | DNA can't be reached and `DNA_FAIL_MODE` is `closed`: visitors get a `403`. The PHP error log says why.                                                                         |
| Nothing              | PHP never ran DNA for that URL: a host cache, a cache plugin's file or a web-server redirect answered first, or the plugin is inactive and the `wp-config.php` line is missing. |

Deactivating the plugin removes its must-use loader but not your
`wp-config.php` line. To turn DNA off, `define('DNA_ENABLED', false);`.

## Configuration

Each is a constant in `wp-config.php`, above the include line, or a variable in
PHP's environment. A constant wins. Nothing is stored in the database.

| Name                        | Default                               | What it does                                                                                          |
| --------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `DNA_API_KEY`               | unset                                 | Your org's key. **Unset means pure passthrough**: nothing is asked.                                   |
| `DNA_ENABLED`               | unset                                 | `false` turns DNA off without removing the key.                                                       |
| `DNA_FAIL_MODE`             | `open`                                | `open`: serve the page when DNA can't answer. `closed`: answer `403` instead.                         |
| `DNA_TIMEOUT_MS`            | `1000`                                | The limit on the whole call to DNA, connecting included.                                              |
| `DNA_PAYMENT_TIMEOUT_MS`    | `10000`                               | The limit for a request that pays: settlement happens inside it.                                      |
| `DNA_EXCLUDE_HEADERS`       | unset                                 | Comma-separated header names that never leave your server. Up to 128: past that, a log warning.       |
| `DNA_EXCLUDE_COOKIES`       | unset                                 | Comma-separated cookie names that never leave your server. Up to 128, likewise.                       |
| `DNA_DEBUG_LOG_RAW_PAYLOAD` | unset                                 | `true` stores every request header on DNA's record, except excluded ones and credentials. Debug only. |
| `DNA_HOSTS`                 | unset                                 | Comma-separated hosts your rules are for. A request naming another is decided as the first.           |
| `DNA_ENDPOINT`              | `https://edge-api.d3.com/v1/decision` | Leave unset unless we give you another.                                                               |

`DNA_HOSTS` matters because the `Host` header is the visitor's to write: on a
server that answers any name, a request naming a host with no rules would skip
yours. Unset, the host a request names is the one decided, so set it, listing
every domain the site serves (a multisite network's, a multilingual plugin's).
`WP_HOME` doesn't stand in for it: many hosts build that from the same header.
**Tools → DNA** fills it in with your site's address.

`DNA_TIMEOUT_MS` is 1 s where the SDKs use 2: PHP opens a new connection to
DNA for each request, and every page waits on it. On PHP 8.5 the connection is
kept between requests.

## What leaves your server

Every request header and cookie, except the names you exclude and these:
`Authorization`, `Proxy-Authorization`, the Cloudflare Access and Vercel OIDC
headers, and `Mcp-Param-Dna-Key`, which goes as a payment header instead. Our
own cookies travel on headers of their own. WordPress's login, post-password
and WooCommerce session cookies are kept back too. DNA is told their names, so
a rule that checks one is skipped. A value past 2 KB, or past 16 KB in
all, is dropped and named; a few headers have their own limit, such as 256
bytes for `Accept`. A body is never sent: its SHA-256 digest is, and for an
MCP call, the method and the tool it names. A file upload's body is read by
PHP before DNA sees it, so a digest the client claims for one is dropped, not
sent.

## Response shape

Every response carries `x-d3-edge`: `pass`, `block`, `fail-open`,
`fail-closed`, `disabled`, or for a priced route `payment-required`,
`payment-redirect` or `payment-stub`. A blocked request gets a `403`, and
WordPress never runs:

```json
{ "blocked": true, "ruleId": "…", "tier": "…", "identity": "…" }
```

From 1.1.0 the plugin answers `/.well-known/d3/check` itself, where the
browser check posts its answer, and WordPress never runs for it: it relays the
post to `/v1/check` beside `DNA_ENDPOINT`'s `/v1/decision`, under your key
([the protocol](https://github.com/d3-inc/d3-dna-adapters/blob/main/PROTOCOL.md#relaying-the-check-post)).
It serves the check script's own files, `/.well-known/d3/check-<version>.js`
and `.css`, the same way: fetched from the check endpoint without your key and
passed on unchanged, so a `script-src 'self'` policy allows them ([the protocol](https://github.com/d3-inc/d3-dna-adapters/blob/main/PROTOCOL.md#relaying-the-check-scripts-files)).
Those answers carry `x-d3-edge: check`. These paths must reach PHP: a host or
web-server rule that serves or denies `/.well-known/` itself, or that answers
a missing `.js` or `.css` file without WordPress, keeps the check from
finishing.

## Paid routes (D3 Pay)

This plugin carries [D3 Pay](../PROTOCOL.md#paid-routes). A priced route
answers an unpaid request with the `402` DNA hands back, or a redirect to pay
when a browser is navigating, and serves the page once the visitor pays.

- **A paying request gets its own budget**, `DNA_PAYMENT_TIMEOUT_MS`, and
  **never falls open**: whatever `DNA_FAIL_MODE` says, a failed call answers
  `502 {"error":"payment_unavailable"}`. The charge may already have landed.
- **WordPress never sees a credential**: no payment header, none of our
  cookies, no `d3pay_*` parameter, and no payment inside an MCP call. They are
  removed from `$_SERVER`, `$_ENV`, `$_COOKIE`, `$_GET` and `$_REQUEST`, from
  `argv` and from Apache's `REDIRECT_QUERY_STRING`, before WordPress loads.
  `getallheaders()` and `getenv()` read the server's own copy of the request,
  which PHP cannot change: read the request from `$_SERVER`.
- **The receipt rides WordPress's own response.** Our `Set-Cookie` and CORS
  list are added beside WordPress's, and the page's `Cache-Control` is narrowed
  to `private` with its freshness kept, so no shared cache stores a receipt.
- **Payment instructions replace the page** as a `200` (`payment-stub`), and
  WordPress never runs.
- **MCP**: a payment in a tool call's `_meta` is removed before your MCP server
  reads it, from the REST body or `php://input`. An unpaid call gets an in-band
  JSON-RPC result with the call's `id`; a paid one gets the receipt in its
  result's `_meta`. A call carrying our credential is refused when DNA can't
  read it: `413` if too large; `400` for a batch, a non-JSON content type, or a
  number JSON can't round-trip (`1e999`). A `?_method=` or
  `X-HTTP-Method-Override` POST is read as a POST. Under a renamed REST prefix,
  a `GET` or `DELETE` the override turns into another method gets a `400`. A
  streamed or compressed result goes out without the receipt.

## Outcome reports

After each response the plugin tells DNA what WordPress answered (status,
time, type and size). It needs PHP to end the response first, which PHP-FPM
and LiteSpeed can and Apache's `mod_php` cannot: there nothing is reported, and
enforcement is unchanged. A report holds a PHP worker while it is sent, so it
gets `DNA_TIMEOUT_MS` and no more, and none is sent after a decision call that
got no answer. A report that cannot be sent is logged and dropped.

Failures are logged to PHP's error log once per kind every few seconds, not
once per request. When DNA times out five times in ten seconds, requests that
don't pay skip it for ten seconds and are served as `DNA_FAIL_MODE` says, so a
slow DNA doesn't hold every PHP worker; a paying request still asks. The plugin
keeps its log throttle, this count, and the MCP key argument a decision turned
on in APCu where PHP has it, otherwise as small files in PHP's temp directory.

## Testing

`wordpress/test/run.sh` runs the plugin in real WordPress (Docker), under
PHP-FPM with nginx and under Apache on PHP 8.3 and 7.4, against a mock DNA. It
first checks the port against the protocol package's own answers
(`openresty/test/parity.json`) on PHP 7.4 and 8.3.
