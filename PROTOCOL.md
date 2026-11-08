# The decision protocol

Every adapter in this repo — and every one you write yourself — speaks the
same contract to the D3 Edge decision endpoint: one call per request in, a
`pass` or `block` out — and, on an adapter that enforces [paid
routes](#paid-routes), sometimes an instruction to answer with instead.
There are two dialects of that call. Adapters that
run code send a JSON `POST` (everything below, until the last section);
proxies with a native auth hook send a forward-auth subrequest instead
([the forward-auth dialect](#the-forward-auth-dialect)). This page is
that contract. If you are installing an existing adapter you don't need
it; read it to write a new one, or to understand exactly what leaves
your infrastructure.

Nothing here is negotiated or versioned per adapter. The endpoint accepts
unknown payload fields and adapters must ignore unknown response fields,
so the contract grows additively — but a field that exists means what it
says here.

## The call

```
POST https://edge-api.d3.com/v1/decision
Authorization: Bearer <your adapter key>
Content-Type: application/json
```

The key is per-org, created in the dashboard, and carries the org that
scopes every policy lookup. It is not host-scoped: one key may report any
host you own.

One call per request, on the request path, with a hard timeout you
choose — each recipe in this repo documents its own default. It is the
only blocking call an adapter makes. An adapter that enforces [paid
routes](#paid-routes) keeps a second, much larger budget for the
requests that present a payment.

## Request

| Field                              | Type                            | Required | Meaning                                                                                |
| ---------------------------------- | ------------------------------- | -------- | -------------------------------------------------------------------------------------- |
| `method`                           | string                          | yes      | The agent's HTTP method.                                                               |
| `url`                              | string                          | yes      | Request target: path plus query, e.g. `/search?q=1`. Not an absolute URL.              |
| `host`                             | string                          | yes      | The `Host` / authority the agent addressed.                                            |
| `headers`                          | object                          | yes      | Lowercase-keyed subset of the agent's headers — see below.                             |
| `requestId`                        | string (≤64)                    | no       | Your correlation id. Links this decision to an outcome report and to logs.             |
| `ip`                               | string                          | no       | The agent's IP. Used for fingerprint matching, then hashed or dropped.                 |
| `timestamp`                        | ISO-8601 or epoch sec           | no       | When you observed the request. Informational.                                          |
| `adapterSet`                       | positive integer                | no       | What you do with the answer — see **Declaring what you can do**. Absent means nothing. |
| `cookies`                          | object                          | no       | From revision 2: every cookie by name — see **Forwarding everything**.                 |
| `droppedHeaders`, `droppedCookies` | string[]                        | no       | Names sent but dropped for length.                                                     |
| `droppedUnlisted`                  | `{ headers, cookies }` booleans | no       | More drops than a list holds: any unlisted name may have been sent.                    |
| `excluded`                         | `{ headers, cookies }` string[] | no       | The names the site keeps back, so they read as withheld, not absent.                   |
| `mcp`                              | `{ method?, tool?, source }`    | no       | From revision 3: the MCP call, read from the body or the `Mcp-*` headers.              |

`url` carries the query because signatures may cover `@query`; strip
nothing. `host` must be the authority the agent used, not your origin's
internal hostname — policy is per `(org, host)`.

### Which headers to forward

Exactly these, when present. A signature covering a header outside this
list comes back `missing-headers`:

```
signature  signature-input  signature-agent  user-agent
content-digest  sec-purpose  x-purpose  purpose
```

Forwarding fewer breaks verification. Below revision 2, forward nothing
else: no cookies, no `authorization`.

### Forwarding everything

From revision 2 an adapter forwards every header and cookie so rules can
read them, minus three sets:

- **Never sent:** `authorization`, `proxy-authorization`, `cookie` (cookies
  go by name in `cookies`), the hop headers, `mcp-param-dna-key`, and the
  platform's own credentials (`x-vercel-oidc-token`, `cf-access-*`).
- **The site's exclusions:** `DNA_EXCLUDE_HEADERS` and `DNA_EXCLUDE_COOKIES`,
  echoed by name in `excluded`.
- **Our own cookies,** which ride headers of their own (below).

A value without a cap of its own stops at 2048 chars, and those values
together at 16 384; past either, the longest go first and each is named in
`droppedHeaders` or `droppedCookies`. Past 128 names a list stops and
`droppedUnlisted` says so; an exclusion list past 128 is echoed capped, with
`droppedUnlisted` set, and every name on it is still withheld. The endpoint reads these values for rules and
does not store them.

An adapter that enforces [paid routes](#paid-routes) forwards four more
groups, each with a length past which the value is dropped rather than
sent:

| Header                                                          | Cap  | Why                                                  |
| --------------------------------------------------------------- | ---- | ---------------------------------------------------- |
| `accept`                                                        | 256  | Agent or browser — picks the `402` or the `302`      |
| `sec-fetch-mode`, `sec-fetch-dest`, `upgrade-insecure-requests` | 32   | The same, for a navigating browser                   |
| `payment-signature`, `x-payment`                                | 4096 | x402, two names because v2 renamed the header        |
| `payment-authorization`                                         | 128  | A D3 Pay handoff or session, for a cookie-less agent |

Plus `d3pay-session`, which is not a client header at all — see
[the credential](#the-credential) — and, from revision 4, `d3-visitor`:
`Cookie: __Secure-d3visitor` under its own name, capped at 96. It is a label
for one browser on one site, never a credential, and the endpoint records it
without ever deciding on it.

### `content-digest` is yours to compute, never to relay

RFC 9421 signatures cover headers, never body bytes. A signed request
binds its body only indirectly, through an RFC 9530 `Content-Digest`
header that the signature covers. So the digest the client sends is a
_claim_: relaying it verbatim would let a tampered body verify.

An adapter computes the digest itself over the bytes it actually
received, and overwrites whatever the client claimed:

- Body present → `content-digest: sha-256=:<base64 of SHA-256>:`
- No body, but a claimed digest → overwrite with the digest of the empty
  body. An empty body must not smuggle a forged claim through.
- No body and no claim → send no `content-digest` at all. Adding one
  fails body-less signed requests as `insufficient-coverage`.
- Body too large to hash within your limits → **strip** the header. The
  request then classifies as unverified, which is honest; forwarding an
  unchecked claim is not.

`GET` and `HEAD` never have a body worth hashing, which is nearly all
agent traffic.

## Response

`200` with a JSON decision:

| Field          | Type                             | Meaning                                                                         |
| -------------- | -------------------------------- | ------------------------------------------------------------------------------- |
| `action`       | `"pass"` \| `"block"`            | What to do. The only field an adapter must handle.                              |
| `policyAction` | `"allow"`/`"block"`/`"log-only"` | What the matched rule asked for. `log-only` yields `pass`.                      |
| `ruleId`       | string                           | The rule that decided. Absent when the org default decided.                     |
| `verdict`      | object                           | How the agent was classified — see below.                                       |
| `failOpen`     | boolean                          | Set when the endpoint itself fell back rather than evaluating.                  |
| `payment`      | object                           | An answer to send instead of reaching the origin — [paid routes](#paid-routes). |

Treat any `action` that is neither `pass` nor `block` as a failure and
apply your fail mode. Do not invent a default.

### The verdict

Rich, and mostly for logging and response headers rather than
enforcement. The fields adapters generally surface:

| Field           | Meaning                                                                                            |
| --------------- | -------------------------------------------------------------------------------------------------- |
| `tier`          | `proven` \| `claimed` \| `derived` \| `spoofed` \| `unverified`, strongest first.                  |
| `identity`      | Canonical agent name when known, else the claimed `Signature-Agent` hostname. Absent on `spoofed`. |
| `impersonating` | On `spoofed` only: the agent whose name the request used.                                          |
| `reason`        | `ok`, or why verification did not reach `proven` (`expired`, `unknown-key`, …).                    |
| `purpose`       | The purposes we assert this agent serves.                                                          |

Unsigned traffic is classified, not rejected: no signature means a
`derived`, `spoofed`, or `unverified` verdict, and policy decides from
there.

### Errors

`401` or `503` with `{ "error": "<reason>" }` — `unknown-key`, `expired`,
`revoked`, or `not-configured`. There is no `403`; a valid key may report
any host.

**Log the reason.** A dead or revoked key looks exactly like a working
site once you fail open, and that log line in your own platform logs is
how it gets diagnosed.

## What an adapter must do

The protocol is half the contract; the rest is behavior every adapter in
this repo implements identically.

1. **Fail open.** A timeout, transport error, non-`200`, or unparseable
   response passes the request through. Enforcement breaking must never
   take the site down. A `closed` fail mode is worth offering as an
   opt-in, never as the default.
2. **Bound the call.** A hard timeout, not a socket default. If the
   platform cannot enforce one, it cannot host a correct adapter.
3. **Ship a kill switch.** An unset decision endpoint means pure
   passthrough, with no call and no dependency on us.
4. **Block with `403`** and a JSON body:
   ```json
   { "blocked": true, "ruleId": "…", "tier": "…", "identity": "…" }
   ```
5. **Tag every response** with `x-d3-edge`: `pass`, `block`, `fail-open`,
   `fail-closed`, or `disabled` — plus `payment-required` and
   `payment-redirect` on an adapter that enforces [paid
   routes](#paid-routes).

Passed traffic then flows to the origin without touching our
infrastructure.

## Paid routes

A site can put a price on a route, and the decision endpoint then answers
with an instruction instead of a verdict. This part of the contract is
**optional**: an adapter that ignores `decision.payment` keeps working
exactly as described above, and the cost it pays is that a priced route
is served free. Implement it or don't — but there is no half of it that
is safe.

The enforcement point never decodes a credential, never learns what a
facilitator is, and never sees the protocol's own header names. It
recognizes presence, picks a budget, forwards one value, and copies back
a status, some headers and a string.

### The credential

A payment rides in one of three places, and an adapter that reads only
some of them is wrong in a way that is hard to see — the missing case
gets the hot-path budget, overruns it, and comes back a block:

| Where                                    | Shape                                                                                                                                               |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Payment-Authorization: Payment <token>` | ≤4096 chars. For an agent with no cookie jar.                                                                                                       |
| `Payment-Signature` / `X-Payment`        | ≤4096 chars. x402.                                                                                                                                  |
| `Cookie: __Host-d3pay=<token>`           | ≤64 chars. The site's own first-party cookie.                                                                                                       |
| `?d3pay_handoff=<id>.<sig>` on the URL   | 22 base64url chars, `.`, 43 more. A redemption.                                                                                                     |
| An MCP call's `_meta`, from revision 3   | `x402/payment` (forwarded base64 as `payment-signature`) or `dna.d3.com/key` (as `payment-authorization`). Removed from the body before the origin. |

The cookie is forwarded **by name, as a header of our own**:
`d3pay-session: <value>`. The raw `Cookie` header is the site's and
never travels.

An MCP call too large to read (over 1 MiB) whose body names one of these
`_meta` keys or the `dna_account_key` argument cannot be stripped, so it is
answered `413 { "error": "mcp_call_too_large" }` and reaches neither the
endpoint nor the origin.

Presence is checked against the caps and nothing else. A value past its
cap is not a payment.

### Declaring what you can do

Some answers are a round trip. The browser check answers a visitor with a
page carrying a script, the browser comes back with what it found, and we
serve it with a cookie the next request has to carry. An enforcement point
that cannot carry that cookie would show the check forever and never finish
it, so the endpoint will not start one unless you say you can.

`adapterSet` is how you say it. Send the highest revision you honour in
full. Send nothing if you honour none — that is the safe answer, and the
one the endpoint assumes.

| Revision | You assert that you                                                                                                                                                                               |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1        | forward `Cookie: __Host-d3person` as `d3pay-person`; append the answer's `Set-Cookie` to the origin's response rather than replacing it; and strip `d3pay_browser` from the URL before the origin |
| 2        | all of 1, and [forward everything](#forwarding-everything) but the never-sent, the site's exclusions and the two cookies it lifts                                                                 |
| 3        | all of 2, and lift an MCP call's payment out of `_meta`, strip it before the origin, answer a `json-rpc` instruction, and put `meta` and the key argument on a JSON-RPC result                    |
| 4        | all of 3, and forward `Cookie: __Secure-d3visitor` as `d3-visitor`, keeping it from the origin with our other two                                                                                 |

All or nothing. A copy of this repository that drops any one of the three
must not claim `1` — the cost falls on that site's own visitors, who get
checked on every page instead of once a day, and whose answer ends up in
the origin's access log as a query parameter.

The pass is **not** a payment. It never buys the budget below.

### The budget

A request presenting a payment gets a second, much larger timeout —
**10 s**, against the hot path's. Settlement happens inside that call and
the caller is waiting for it. The hot-path budget on a redemption is a
guaranteed timeout, and with `DNA_FAIL_MODE=closed` a guaranteed `403` for
someone who just paid.

### The answer

`decision.payment` is an instruction, not a decision to make:

| Field      | Meaning                                                                                        |
| ---------- | ---------------------------------------------------------------------------------------------- |
| `status`   | Answer with this instead of reaching the origin. Absent ⇒ pass on.                             |
| `headers`  | Headers to put on the answer, or on the origin's response.                                     |
| `body`     | Already serialized. Ignored when `status` is absent.                                           |
| `bodyKind` | `json-rpc`: answer `200` with `{ jsonrpc, id, result: body }`, `id` from the call. Revision 3. |
| `meta`     | On a pass, merged into a JSON-RPC result's `_meta`: the receipt. Revision 3.                   |

Send it verbatim, plus `cache-control: no-store` and your `x-d3-edge`
tag. Two rules the adapter owns:

- **A redirect (`3xx`) carries no body and no `content-type`.** A JSON
  type on a redirect misleads the client that follows it.
- **Re-check every header name and value** before it reaches a header
  table — token characters only, printable ASCII only, dropped rather
  than escaped. These values are provider and tenant authored, and your
  adapter is the last place before the wire.

Tag a `402` `payment-required`, a `3xx` `payment-redirect`, and anything
else `fail-closed`.

### Failing closed, exactly here

**A request presenting a payment never falls open.** Whatever the fail
mode says, a decision call that times out or errors on such a request
answers:

```
502  { "error": "payment_unavailable" }
```

Fail-open exists so enforcement breaking cannot take a site down. It
does not extend to a page that is priced and may already have been
charged for: serving that free is the failure, not the `502`.

### Passing clean, returning rich

On a pass, the origin must see no credential it could replay. Before
forwarding: delete the payment headers, remove `__Host-d3pay` from the
`Cookie` header and leave every other cookie alone, and drop
`d3pay_handoff` from the URL. Do this whether or not the request counted
as presenting a payment — an oversized value is not a payment, and it
still must not reach the origin.

Then put `payment.headers` on the origin's own response. `Set-Cookie`
and `Access-Control-Expose-Headers` are **appended**; everything else is
set. Replacing the origin's `Set-Cookie` would log the visitor out of
the site to hand them ours, and replacing its CORS list would revoke a
browser's access to headers the site deliberately exposed.

### Sampling

If your adapter samples traffic, a request presenting a payment is
exempt from the draw. Unsampled, the visitor paid for a page that was
then served to everybody free.

(Sampling has this cost anyway: an unsampled request on a priced route
is served free. That is inherent to ramping, and it argues for full
coverage once you price anything.)

## Outcome reports (optional)

An adapter that proxies the response — as opposed to one that only
returns a verdict to a proxy — can report what the origin actually did,
after responding, without blocking anything:

```
POST https://edge-api.d3.com/v1/report
Authorization: Bearer <your adapter key>
```

Body: `requestId` (matching the decision), `ts` (epoch ms), `host`,
`path`, `method`, `mode` (the `x-d3-edge` value), and optionally
`status`, `originLatencyMs`, `contentType`, `contentLength`. Failures are
logged and swallowed — a report never affects a response.

Adapters that cannot defer work past the response (Cloudflare Snippets,
config-only proxies) simply skip this. Enforcement does not depend on it.

## The forward-auth dialect

Most proxies ship a native hook for exactly this shape — Caddy
`forward_auth`, nginx `auth_request`, Traefik `ForwardAuth`, Envoy
`ext_authz` — where the proxy sends a side-request per request and reads
the status code. The endpoint speaks that dialect directly, which makes
those proxies config-file installs with no adapter code at all:

```
GET https://edge-api.d3.com/v1/forward-auth
x-d3-adapter-key: <your adapter key>
```

The key rides in `x-d3-adapter-key`, never `Authorization` — proxies
forward the end user's own `Authorization` header, so the bearer slot is
taken. The route accepts any method: some hooks mirror the original
request's method onto the subrequest.

### Request

The original request rides in headers. The endpoint reads the first
complete convention of these two — only headers the proxy itself
overwrites, because the proxy also copies the client's own headers onto
the side-request, and a visitor-settable convention would let a visitor
describe a different request than the one they made:

| Convention      | Headers                                                     | Set by                        |
| --------------- | ----------------------------------------------------------- | ----------------------------- |
| `X-Forwarded-*` | `X-Forwarded-Method`, `X-Forwarded-Host`, `X-Forwarded-Uri` | Caddy, Traefik; nginx recipes |
| `X-Original-*`  | `X-Original-URL` (absolute) + `X-Original-Method`           | ingress-nginx convention      |

A recipe that builds the tuple by hand sets the `X-Forwarded-*` headers. Once
`X-Forwarded-Uri` arrives, the endpoint reads that convention alone: a tuple
missing its host or method is malformed, never completed from an `X-Original-*`
a visitor could have set. An `X-Forwarded-Uri` with a scheme
(`http://host/path`, or `http:/path`, which Go also accepts) is read by
its path and query, the page the proxy serves.

The client IP comes only from a recipe-pinned `x-d3-real-ip`; raw
`X-Forwarded-For` is client-spoofable and deliberately never read, and
`X-Real-IP` cannot be used — Cloudflare-fronted endpoints rewrite it to
the connecting IP, which is the enforcement point's own egress. The client's own headers — the signature set from [Which
headers to forward](#which-headers-to-forward) — arrive because the proxy
copies them onto the side-request; below revision 2, recipes must strip
`Cookie`, `Authorization`, `Proxy-Authorization`, and any inbound `x-d3-*`.
`requestId` is generated server-side, and there are no outcome reports —
there is no adapter code to send one.

### Revision 2

A proxy declares its revision in `x-d3-adapter-set`, the header form of
[`adapterSet`](#declaring-what-you-can-do). Declare at most `2`: revision 3
rewrites bodies, which no forward-auth hook can. From `2` the endpoint:

- reads every header and cookie on the side-request but `Authorization`,
  `Proxy-Authorization`, the proxy's own headers (the tuple, `Via`,
  `X-Forwarded-For`), and those the endpoint's CDN adds (`cf-*`,
  `cdn-loop`, `x-real-ip`);
- drops on arrival the names the proxy lists, comma-separated, in
  `x-d3-excluded-headers` and `x-d3-excluded-cookies`, and reads them as
  withheld, as an [exclusion](#forwarding-everything) reads;
- reads `d3pay-session` and `d3pay-person`, which the proxy sets from the
  `__Host-d3pay` and `__Host-d3person` cookies;
- answers a gate, below.

The proxy sets `x-d3-adapter-set`, both exclusion lists and both `d3pay-*`
headers itself, overwriting any copy the visitor sent. A
visitor's own exclusion list would mark a header withheld and skip the rule
condition that should hold it.

### Response

Below revision 2, the status code is the whole answer:

| Status | Meaning                                                                                                                                                                                                                  |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `200`  | Continue. `x-d3-edge: pass` — or `x-d3-edge: fail-open` plus an `x-d3-reason` when the endpoint fell back (see below).                                                                                                   |
| `403`  | Deny. The JSON block body from [What an adapter must do](#what-an-adapter-must-do), plus `x-d3-rule-id` / `x-d3-tier` headers — nginx discards a deny body; Caddy, Traefik, and Envoy return it to the visitor verbatim. |

Nothing else is ever returned on purpose. In particular, **a dead,
revoked, or missing adapter key answers `200` with `x-d3-edge:
fail-open`, never `401`** — a proxy can't tell "block this bot" from
"your key expired," and an auth error would deny every visitor on the
site. The same applies to a malformed subrequest (`x-d3-reason:
malformed-tuple`): misconfiguration fails open, loudly, on our side.
Fail-open moves server-side in this dialect; the proxy-side recipe still
needs its own fail-open for the case where the endpoint is unreachable
(each recipe documents its pattern).

### Paid routes from revision 2

Below revision 2 the endpoint evaluates no gate: a priced route reached
through forward-auth is answered `200` or `403` like any other, never
paywalled and never charged.

From revision 2 it answers a gate as the JSON dialect's
[payment instruction](#the-answer) would, already rendered. The proxy
returns it whole, status, body and headers:

| Answer                                 | The proxy                                                                                                                                                                                                                                                                                      |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `402`, `x-d3-edge: payment-required`   | Returns it: a price, or the browser check                                                                                                                                                                                                                                                      |
| `3xx`, `x-d3-edge: payment-redirect`   | Returns it, with no body                                                                                                                                                                                                                                                                       |
| `200`, `x-d3-edge: payment-stub`       | Returns it in place of the page, and never calls the origin                                                                                                                                                                                                                                    |
| `502`, `x-d3-edge: fail-closed`        | Returns it: a payment could not be taken                                                                                                                                                                                                                                                       |
| `403`, `x-d3-edge: block`, HTML        | Returns it: a block rule's browser check, which lets the visitor through once it passes                                                                                                                                                                                                        |
| `200`, `x-d3-edge: pass`, with headers | Calls the origin, then puts the answer's headers on the origin's response, as in [Passing clean, returning rich](#passing-clean-returning-rich). An answer's `Cache-Control: no-store` replaces the origin's, and no other value from it does; a paid page without it is narrowed to `private` |

[Failing closed](#failing-closed-exactly-here) and the
[budget](#the-budget) apply as written: a request presenting a payment
gets the longer timeout, and never falls open. Declare `2` only if your
recipe does all of this and keeps DNA's credentials from the origin.

A visitor can send `x-d3-adapter-set: 2` through a recipe that doesn't
set it, and that recipe reads any `2xx` as allow. So on this dialect no
answer that refuses the page is a `2xx`: a block rule's check, a `200`
on the JSON dialect, comes here as a `403`. The one other `2xx`,
`payment-stub`, only replaces a page that would otherwise be served
free.

### The body is usually unattested

The side-request is body-less on most proxies, so a `content-digest` on
a signed `POST`/`PUT` is the client's claim, checked by nobody. The
signature still proves the signer, but not the message: those verdicts
are capped at `claimed` with reason `body-unattested` instead of
`proven`. `GET`/`HEAD` — nearly all agent traffic — are unaffected.
Proxies that can forward the raw body (Traefik `forwardBody`, Envoy
`with_request_body`) escape the cap: the endpoint hashes what it
receives and verifies fully.

## Writing a new adapter

The shortest correct implementation in this repo is
[`cloudflare-snippet/snippet.js`](./cloudflare-snippet/snippet.js) — one
self-contained file, no imports, all of the above in about 160 lines.
Read it as the reference, then port. If you build one for a platform we
don't cover, we'd like to hear about it:
[hello@d3.com](mailto:hello@d3.com).
