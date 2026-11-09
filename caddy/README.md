# DNA for Caddy

[DNA](https://ai.d3.com) enforcement in stock Caddy config: no plugin, no
custom build. Caddy asks DNA about each request, then serves the page, a block,
or DNA's answer to a **Charge** or **Require a human** rule: a `402`, a redirect
to DNA, or DNA's payment instructions in place of your page.

This is the forward-auth dialect of [the decision
protocol](../PROTOCOL.md#the-forward-auth-dialect): the original method and URL
ride in `X-Forwarded-*` headers, and the visitor's own headers, Web Bot Auth
signatures included, are copied along.

## Requirements

Caddy 2.11.7 or later (tested on 2.11.7 and 2.11.8). Earlier releases cannot
run this file: before 2.11.6 Caddy will not start with it, and before 2.11.7
it reads every request as paying.

## Install

1. Put [`dna.caddy`](./dna.caddy) beside your Caddyfile.
2. Add `import dna.caddy` once, at the top level and below your global options
   block if you have one, and `invoke dna` in each site you want covered.
   [`Caddyfile`](./Caddyfile) shows where. `invoke` runs before your `handle`
   blocks wherever the line sits, and DNA judges the URL the visitor sent, not
   what a `rewrite` or `try_files` made of it.
3. Create an API key at [dashboard.d3.com/keys](https://dashboard.d3.com/keys)
   and set it as `DNA_API_KEY` in Caddy's environment.
4. Restart Caddy. A reload doesn't give a running Caddy a new environment
   variable.

Ports 8113 and 8114 on `127.0.0.1` are the recipe's own. If something else uses
them, replace every `8113` and `8114` in `dna.caddy`.

Coming from the earlier `forward_auth` block? Remove it and its `http://:8113`
site first. Left beside `dna.caddy`, the duplicate site stops Caddy loading, and
a `forward_auth` left in a site asks DNA twice per request. Then rename
`D3_EDGE_ADAPTER_KEY` in Caddy's environment to `DNA_API_KEY`: left under the
old name, the key never reaches DNA and nothing is enforced.

## Revisions

`dna.caddy` sends its revision in `x-d3-adapter-set`, and DNA answers only with
what that revision can show. To upgrade, replace `dna.caddy` and reload; your
Caddyfile does not change.

| Revision                                | Carries                                                                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| none (the earlier `forward_auth` block) | Let in and Block, on a fixed list of headers. **Charge** and **Require a human** pages are served as ordinary pages            |
| 2                                       | Every header and cookie but your exclusions, and every rule: Let in, Block, Charge, Require a human, Charge or require a human |

An **MCP server** rule answers here as an **API** rule does. Charging per tool
call is revision 3, which rewrites request and response bodies, and stock Caddy
cannot.

## What each answer looks like

| DNA answers                                          | The visitor gets                                                                      |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Let in                                               | Your page                                                                             |
| Block                                                | `403` with a JSON body                                                                |
| Block, to a browser DNA cannot yet tell from a bot   | `403` with DNA's check page; your page once the browser passes                        |
| A price or a human check                             | A `302` to DNA, or a `402` saying how to pay or sign in                               |
| A price, to a browser DNA cannot yet tell from a bot | `402` with DNA's check page                                                           |
| Payment instructions, to some agents                 | DNA's instructions as a `200` tagged `x-d3-edge: payment-stub`, in place of your page |
| Paid                                                 | Your page, with the receipt and DNA's session cookie added                            |
| Payment could not be taken                           | `502`, never your page                                                                |

A paid page gets `Cache-Control: private`, with your freshness directives kept,
so no shared cache serves it to another visitor.

## How fail-open works

A subrequest that errors reaches the visitor as an error. The recipe puts a
local gateway in front of the decision endpoint so DNA being down never takes
your site down:

| Request            | Budget (variable)            | If DNA is down, slow, or failing                |
| ------------------ | ---------------------------- | ----------------------------------------------- |
| No payment         | 500 ms (`DNA_TIMEOUT`)       | `200`, your page served, `x-d3-edge: fail-open` |
| Presents a payment | 10 s (`DNA_PAYMENT_TIMEOUT`) | `502 payment_unavailable`, never a free page    |

Both budgets take a Caddy duration, such as `750ms`.

"Failing" covers three things: no connection, a `5xx` or `429` with no
`x-d3-edge` (from a proxy in between, never a decision), and DNA's own
`fail-open` answer. Every decision DNA makes carries `x-d3-edge`. Any other
status without it, such as a `431` for headers too large to forward, reaches
the visitor as it came.

A request presents a payment when it carries `Payment-Signature`, `X-Payment`
or `Payment-Authorization`, the `__Host-d3pay` cookie, or `?d3pay_handoff=` on
the URL. Settlement happens inside the 10 s.

A missing, unknown, expired or revoked key also answers `200 fail-open`, with
`x-d3-reason` set to `unknown-key`, `expired` or `revoked`. Alert on it: nothing
is enforced, and a visitor holding a DNA session gets a `502` on every page
until the key works. To check a key:

```sh
curl -sI https://edge-api.d3.com/v1/forward-auth \
  -H "x-d3-adapter-key: $DNA_API_KEY" | grep -i '^x-d3-reason'
```

A good key prints `malformed-tuple`: this check sends no request to judge.

## What leaves your infrastructure

To DNA:

- The visitor's headers and cookies, minus `Authorization` and
  `Proxy-Authorization`. `__Host-d3pay` and `__Host-d3person` also travel as
  `d3pay-session` and `d3pay-person`.
- Names in `DNA_EXCLUDE_HEADERS` and `DNA_EXCLUDE_COOKIES` (comma-separated, in
  Caddy's environment) still travel; DNA drops them on arrival and reads them as
  withheld. To keep a header on your server, add `header_up -Name` to the
  `reverse_proxy {vars.d3_gateway}` block in `dna.caddy`, and again after each
  upgrade.
- Host, method and URL come from the request Caddy received, and the key and
  revision from `dna.caddy`. Behind a load balancer, set `trusted_proxies` and
  turn on `trusted_proxies_strict`, or a visitor can choose the IP DNA sees.
- No request body, so a signed `POST` or `PUT` gets a capped verdict
  (`claimed`, reason `body-unattested`); `GET` and `HEAD` are unaffected.

To your origin: nothing of DNA's. No payment header, neither cookie, and no
`d3pay_handoff`, `d3pay_check` or `d3pay_browser` on the URL. The receipt and
DNA's `Set-Cookie` are added to your response, never to the request your
origin sees.

A URL without those three reaches your origin byte for byte. One that carries
them, which only happens on the way back from DNA, has the rest of its query
rewritten in Caddy's encoding, sorted by name.

## Coverage

On a site with **Charge** or **Require a human** rules, put `invoke dna` in the
site with no matcher. A request it skips never reaches DNA, so a priced page is
served free. Sampling, or matching only signed agents, skips requests. A request
with no `Host` names no site to check, so the recipe answers it `400`.

Use `invoke dna` in sites named by host. On a catch-all site (`:80`, `:443`) the
visitor picks the `Host` DNA checks, so a page served whatever the `Host` is
judged by the rules of any host they name, or by none.

Set such a site's caching on the origin, not with Caddy's `header` directive.
DNA's answers carry `Cache-Control: no-store` and a paid page gets the origin's
value narrowed; a `header` directive in the site can rewrite either.

## Testing it

[`test/run.sh`](./test/run.sh) runs `dna.caddy` in real Caddy against a mock
decision endpoint and origin: every answer above, what reaches DNA and the
origin, a site built of `handle` blocks and `try_files`, DNA failing in each
way, and both budgets. It needs `caddy` and `node` on `PATH`.
