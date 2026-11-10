# DNA for nginx (OpenResty)

[DNA](https://ai.d3.com) in nginx's own phases, before your site sees the
request. Per request it asks DNA for a decision and then serves the page, a
`403`, or the rule's own answer: a `402` with a price, a redirect to pay, or
payment instructions in place of the page. Nothing runs beside nginx. If DNA
errors or is slow, your site serves as usual, except to a visitor who is
paying.

Every rule works, as on Cloudflare: any header or cookie, **Charge** and
**Require a human**, DNA's check page for browsers, and MCP tool calls charged
per call. After each response it reports what your origin answered.

On a pass that carries DNA's verdict it also hands it to your upstream as
`X-D3-Tier` and `X-D3-Identity` request headers. They're set only on paths one
of your rules covers. A visitor's own copies never reach your upstream.

## Requirements

[OpenResty](https://openresty.org/), plus one library:

```sh
opm get ledgetech/lua-resty-http
```

Without it, every request is handled as if DNA couldn't be reached, so
`DNA_FAIL_MODE` applies, and the error log says the library is missing.

A plain nginx build with `ngx_http_lua_module` also needs the libraries
OpenResty bundles: lua-cjson, lua-resty-lrucache and lua-resty-string. Without
one, DNA's code can't load and the error log says which is missing. Pages are
still served, but a request carrying a payment, one of DNA's cookies or a
`d3pay_*` parameter gets a `502`, since nothing can strip them.

## Install

1. Save the files of this directory in `/etc/nginx/lua/`: `dna.lua`,
   `dna_access.lua`, `web_bot_auth_verify.lua`, `dna.main.conf` and
   `dna.server.conf`. If you keep them elsewhere, change the one path in
   `dna.server.conf` to match.
2. In `nginx.conf`, as [`nginx.conf`](./nginx.conf) here shows:
   - `include /etc/nginx/lua/dna.main.conf;` at the top, outside `http {}`;
   - a `resolver`, `resolver_timeout` and `lua_ssl_trusted_certificate` in
     `http {}`;
   - `include /etc/nginx/lua/dna.server.conf;` in each `server` you want
     covered. Every location in it inherits DNA.
3. Set `DNA_API_KEY` in nginx's environment, with your key from
   [dashboard.d3.com/keys](https://dashboard.d3.com/keys): for systemd, an
   `Environment=` line under `[Service]` in `sudo systemctl edit openresty`,
   and for a container, its env. Then restart nginx with
   `sudo systemctl restart openresty`. nginx reads its environment once, so a
   reload keeps the old value; a value written into `nginx.conf` itself as
   `env DNA_API_KEY=…;` does change on reload.

Check it with `curl -sI https://www.example.com/` and read `x-d3-edge`.
`nginx -t` can't check this for you: DNA's Lua loads on the first request.

| You see                                                         | It means                                                                                                                                             |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pass`                                                          | DNA is live.                                                                                                                                         |
| `disabled`                                                      | DNA is off: `DNA_ENABLED=false`, or nginx can't see `DNA_API_KEY` because `dna.main.conf` isn't included or nginx hasn't restarted since you set it. |
| `fail-open`                                                     | DNA can't be reached, or a library or file it needs is missing. The error log says which.                                                            |
| No `x-d3-edge`, and a `404`, a `500` or no answer on every page | `dna_access.lua` is missing, or one of DNA's files was edited. The error log names it.                                                               |
| No `x-d3-edge` on some paths only                               | Those locations run their own `access_by_lua`: see [Locations with their own Lua](#locations-with-their-own-lua).                                    |

### Upgrading from one access line

An install from before the include files has an `access_by_lua_file` line
for `web_bot_auth_verify.lua` in its locations. That still works, at
revision 1: rules see a fixed list of headers and no cookies, MCP tool calls
aren't charged, and nothing is reported. To upgrade, save the new files, add
both includes, and delete every old `access_by_lua_file` line: one left in a
location replaces the include's there. Your old `env` lines can stay.

## Configuration

Each needs its `env` line, which `dna.main.conf` already has:

| Variable                    | Default                               | What it does                                                                                                 |
| --------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `DNA_API_KEY`               | unset                                 | Your org's key. **Unset means pure passthrough**: nothing is asked.                                          |
| `DNA_ENABLED`               | unset                                 | `false` turns DNA off without removing the key.                                                              |
| `DNA_FAIL_MODE`             | `open`                                | `open`: serve the page when DNA can't answer. `closed`: answer `403` instead.                                |
| `DNA_TIMEOUT_MS`            | `150`                                 | The limit on each step of asking DNA: connecting, sending, and each read.                                    |
| `DNA_PAYMENT_TIMEOUT_MS`    | `10000`                               | The budget for a request that pays: settlement happens inside it.                                            |
| `DNA_EXCLUDE_HEADERS`       | unset                                 | Comma-separated header names that never leave your server. Up to 128: past that, a warning in the error log. |
| `DNA_EXCLUDE_COOKIES`       | unset                                 | Comma-separated cookie names that never leave your server. Up to 128, likewise.                              |
| `DNA_DEBUG_LOG_RAW_PAYLOAD` | unset                                 | `true` keeps every request header (but the excluded and the credentials below) on DNA's record. Debug only.  |
| `DNA_ENDPOINT`              | `https://edge-api.d3.com/v1/decision` | Leave unset unless we give you another.                                                                      |

## What leaves your server

Every request header and cookie, except the names you exclude and these:
`Authorization`, `Proxy-Authorization`, the Cloudflare Access and Vercel OIDC
headers, and `Mcp-Param-Dna-Key`, which goes as a payment header instead. Our
own two cookies travel on headers of their own. A value past 2 KB, or past
16 KB in all, is dropped and named; a few headers have their own limit, such as
256 bytes for `Accept`. A body is never sent: its SHA-256 digest is, and for an
MCP call, the method and the tool it names.

## Response shape

Every response carries `x-d3-edge`: `pass`, `block`, `fail-open`,
`fail-closed`, `disabled`, or for a priced route `payment-required`,
`payment-redirect` or `payment-stub`. A blocked request gets a `403`:

```json
{ "blocked": true, "ruleId": "…", "tier": "…", "identity": "…" }
```

## Paid routes (D3 Pay)

This install carries [D3 Pay](../PROTOCOL.md#paid-routes). A priced route
answers an unpaid request with the `402` DNA hands back, or a redirect to pay
when a browser is navigating, and serves the page once the visitor pays.

- **A paying request gets its own budget**, `DNA_PAYMENT_TIMEOUT_MS`, and
  **never falls open**: whatever `DNA_FAIL_MODE` says, a failed call answers
  `502 {"error":"payment_unavailable"}`. The charge may already have landed.
- **Your upstream never sees a credential**: no payment header, neither of our
  cookies, no `d3pay_*` parameter, and no payment inside an MCP call.
- **The receipt rides your upstream's own response.** Our `Set-Cookie` and
  CORS list are added beside yours, and the page's `Cache-Control` is narrowed
  to `private` with its freshness kept, so no shared cache stores a receipt.
- **Payment instructions replace the page** as a `200` (`payment-stub`), and
  your upstream is not called.
- **MCP**: a payment in a tool call's `_meta` is lifted out and the call
  reaches your server without it. An unpaid call is answered in band, as a
  JSON-RPC result with the call's `id`; a paid one gets the receipt in its
  result's `_meta`. A call too large to read that names one of our credentials
  is refused with a `413`; a batch, or a call sent under another content type
  or as a GET, that carries one is refused with a `400`. To add the receipt, the script asks your server
  for an uncompressed result.

## Outcome reports

After each response the install tells DNA what your origin answered (status,
time, type and size) without delaying the visitor. A report that cannot be
sent is logged and dropped, and none is sent while DNA can't be reached at all.
Under a burst it sends none while 128 Lua timers are running in the worker,
yours included, so your own timers keep their headroom.

Failures are logged once per kind every few seconds, not once per request.
nginx also logs a line of its own for each failed connection;
`lua_socket_log_errors off;` in `http {}` turns those off.

## Locations with their own Lua

nginx runs one Lua handler per phase in a location. Search your config for
`_by_lua` first: a location that sets its own handler for a phase replaces
DNA's there.

| Its own               | What happens there                                            |
| --------------------- | ------------------------------------------------------------- |
| `access_by_lua`       | DNA never asks about requests to it                           |
| header or body filter | A paid page keeps your caching; an MCP result gets no receipt |
| `log_by_lua`          | Nothing is reported                                           |

The error log names the path for the first two. Move your Lua to
`rewrite_by_lua`, which DNA leaves free.

## `$request_uri` keeps our parameters

nginx's `$request_uri` is the URL as the visitor sent it, so the
`d3pay_handoff` and `d3pay_browser` parameters DNA strips are still in it. Pass
`$uri$is_args$args` on instead: a PHP site sets
`fastcgi_param REQUEST_URI $uri$is_args$args;` after `include fastcgi_params;`,
and a `proxy_pass` should not name `$request_uri`.

## Testing

`nginx/test/run.sh` runs this install in real OpenResty (Docker) against a mock
DNA and checks the port against the protocol package's own answers
(`test/parity.json`).

### Earlier names

An install set up with the earlier names keeps working, and a `DNA_` name wins
when both are set. With the earlier names, `POLICY_WORKER_URL` is still what
switches DNA on.

| Earlier name                | Now                          |
| --------------------------- | ---------------------------- |
| `POLICY_ADAPTER_KEY`        | `DNA_API_KEY`                |
| `POLICY_WORKER_URL`         | `DNA_ENDPOINT`, now optional |
| `POLICY_TIMEOUT_MS`         | `DNA_TIMEOUT_MS`             |
| `POLICY_PAYMENT_TIMEOUT_MS` | `DNA_PAYMENT_TIMEOUT_MS`     |
| `FAIL_MODE`                 | `DNA_FAIL_MODE`              |

To move over, rename each variable and drop `POLICY_WORKER_URL`. If you turned
DNA off by leaving `POLICY_WORKER_URL` unset, set `DNA_ENABLED=false` first:
`DNA_API_KEY` switches DNA on by itself.
