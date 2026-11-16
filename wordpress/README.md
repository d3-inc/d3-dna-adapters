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
own copies never reach WordPress.

## What it covers

DNA runs in PHP, so it sees what PHP serves.

| Request                                                                    | Checked                                         |
| -------------------------------------------------------------------------- | ----------------------------------------------- |
| Pages, the REST API, `wp-admin`, `wp-login.php`, feeds                     | Yes                                             |
| A page-cache plugin's hit (WP Super Cache, W3 Total Cache, WP Rocket…)     | Only with the `wp-config.php` line (Install, 3) |
| Files your web server sends itself: images, CSS, JS, uploads               | No: they never reach PHP                        |
| Pages your host caches in front of PHP (WP Engine, Kinsta, Cloudflare APO) | No                                              |

For the last two, put DNA in front of your site instead:
[Cloudflare](../packages/cloudflare-adapter), or
[nginx](../openresty) if you run your own server.

## Requirements

- WordPress 6.0 or later, PHP 7.4 or later, with the `curl` extension. Without
  curl every request is handled as if DNA couldn't be reached, so
  `DNA_FAIL_MODE` applies, and the status screen says curl is missing.

## Install

1. Copy [`d3-dna/`](./d3-dna) into `wp-content/plugins/`, or make a zip for
   **Plugins → Add New → Upload Plugin** from a checkout of this repo:
   ```sh
   git archive --format=zip --prefix=d3-dna/ HEAD:wordpress/d3-dna > d3-dna.zip
   ```
2. Activate **DNA by D3**. It runs from then on, as a must-use plugin it
   installs, before your other plugins load.
3. In `wp-config.php`, above the line that requires `wp-settings.php`, set
   your key from [dashboard.d3.com/keys](https://dashboard.d3.com/keys) and
   run DNA before any page cache:
   ```php
   define('DNA_API_KEY', 'your key');
   if (is_file(__DIR__ . '/wp-content/plugins/d3-dna/boot.php')) include __DIR__ . '/wp-content/plugins/d3-dna/boot.php';
   ```
   If your `wp-content` lives elsewhere, change both paths. The `is_file`
   guard keeps your site up while WordPress replaces the plugin's files during
   an update.

Check it under **Tools → DNA**: **Check the home page** fetches it and reads
`x-d3-edge`. Or run `curl -sI https://www.example.com/`.

| You see     | It means                                                                                |
| ----------- | --------------------------------------------------------------------------------------- |
| `pass`      | DNA is live.                                                                            |
| `disabled`  | DNA is off: `DNA_ENABLED` is `false`, or `DNA_API_KEY` is not set where PHP can see it. |
| `fail-open` | DNA can't be reached, or PHP has no curl. The PHP error log says which.                 |
| Nothing     | DNA didn't run: the plugin is inactive and the `wp-config.php` line is missing.         |

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
| `DNA_DEBUG_LOG_RAW_PAYLOAD` | unset                                 | `true` keeps every request header (but the excluded and the credentials) on DNA's record. Debug only. |
| `DNA_ENDPOINT`              | `https://edge-api.d3.com/v1/decision` | Leave unset unless we give you another.                                                               |

`DNA_TIMEOUT_MS` is 1 s where the SDKs use 2: PHP opens a new connection to
DNA for each request, and every page waits on it. On PHP 8.5 the connection is
kept between requests.

## What leaves your server

Every request header and cookie, except the names you exclude and these:
`Authorization`, `Proxy-Authorization`, the Cloudflare Access and Vercel OIDC
headers, and `Mcp-Param-Dna-Key`, which goes as a payment header instead. Our
own cookies travel on headers of their own. A value past 2 KB, or past 16 KB in
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

## Paid routes (D3 Pay)

This plugin carries [D3 Pay](../PROTOCOL.md#paid-routes). A priced route
answers an unpaid request with the `402` DNA hands back, or a redirect to pay
when a browser is navigating, and serves the page once the visitor pays.

- **A paying request gets its own budget**, `DNA_PAYMENT_TIMEOUT_MS`, and
  **never falls open**: whatever `DNA_FAIL_MODE` says, a failed call answers
  `502 {"error":"payment_unavailable"}`. The charge may already have landed.
- **WordPress never sees a credential**: no payment header, none of our
  cookies, no `d3pay_*` parameter, and no payment inside an MCP call. They are
  removed from `$_SERVER`, `$_COOKIE`, `$_GET` and `$_REQUEST` before WordPress
  loads. `getallheaders()` reads the server's own copy, which PHP cannot
  change, so read request headers from `$_SERVER`.
- **The receipt rides WordPress's own response.** Our `Set-Cookie` and CORS
  list are added beside WordPress's, and the page's `Cache-Control` is narrowed
  to `private` with its freshness kept, so no shared cache stores a receipt.
- **Payment instructions replace the page** as a `200` (`payment-stub`), and
  WordPress never runs.
- **MCP**: a payment in a tool call's `_meta` is lifted out, and the call
  reaches your MCP server without it, whether it reads the REST API's body or
  `php://input`. An unpaid call is answered in band, as a JSON-RPC result with
  the call's `id`; a paid one gets the receipt in its result's `_meta`. A call
  too large to read that names one of our credentials is refused with a `413`;
  a batch, or a call sent under another content type, that carries one is
  refused with a `400`. A result your server streams, or sends compressed, is
  passed on without the receipt.

## Outcome reports

After each response the plugin tells DNA what WordPress answered (status,
time, type and size). It needs PHP to end the response first, which PHP-FPM
and LiteSpeed can and Apache's `mod_php` cannot: there nothing is reported, and
enforcement is unchanged. A report that cannot be sent is logged and dropped.

Failures are logged to PHP's error log once per kind every few seconds, not
once per request.

## Testing

`wordpress/test/run.sh` runs the plugin in real WordPress (Docker), under
PHP-FPM with nginx and under Apache on PHP 8.3 and 7.4, against a mock DNA. It
first checks the port against the protocol package's own answers
(`openresty/test/parity.json`) on PHP 7.4 and 8.3.
