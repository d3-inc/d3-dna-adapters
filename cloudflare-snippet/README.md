# D3 Edge Cloudflare Snippet

[D3 Edge](https://ai.d3.com) enforcement as a [Cloudflare
Snippet](https://developers.cloudflare.com/rules/snippets/) — a single
file pasted into your zone, no Worker deploy. Snippets are included at
no extra cost on every paid Cloudflare plan (the free tier doesn't have
them). Same decision, same `403`, same fail-open as the worker installs.

## Install

1. In the Cloudflare dashboard: your zone → **Rules → Snippets →
   Create a Snippet**.
2. Paste [`snippet.js`](./snippet.js) and fill in `apiKey` — create
   the key at
   [dashboard.d3.com/keys](https://dashboard.d3.com/keys) — plus
   anything else in `CONFIG` you want to change.
3. Scope it with a snippet rule like `http.host eq "www.example.com"`
   and deploy.

Check it's live with `curl -sI https://www.example.com/` — every
response carries an `x-d3-edge` header once it is.

## Configuration

`CONFIG` at the top of the file, mapping onto the worker adapters'
variables where they exist:

| Constant             | Worker equivalent        | Default                               | What it does                                                                        |
| -------------------- | ------------------------ | ------------------------------------- | ----------------------------------------------------------------------------------- |
| `apiKey`             | `DNA_API_KEY`            | —                                     | Your org's key, bearer for the decision call. Unset means pure passthrough.         |
| `enabled`            | `DNA_ENABLED`            | `true`                                | `false` turns DNA off without removing the key: pure passthrough.                   |
| `failMode`           | `DNA_FAIL_MODE`          | `open`                                | `open`: pass traffic when the call fails. `closed`: block instead.                  |
| `timeoutMs`          | `DNA_TIMEOUT_MS`         | `150`                                 | Hard budget for the decision call.                                                  |
| `paymentTimeoutMs`   | `DNA_PAYMENT_TIMEOUT_MS` | `10000`                               | Budget for a request presenting a payment — settlement happens inside it.           |
| `endpoint`           | `DNA_ENDPOINT`           | `https://edge-api.d3.com/v1/decision` | Decision endpoint, not in `CONFIG` by default. Add it only if we give you another.  |
| `sampleRate`         | —                        | `1`                                   | Fraction of requests that get a decision call. Unsampled requests return untouched. |
| `alwaysSampleSigned` | —                        | `false`                               | Call on every request carrying signature headers, whatever `sampleRate` says.       |
| `excludeHeaders`     | `DNA_EXCLUDE_HEADERS`    | `''`                                  | Comma-separated header names DNA is never sent — see What DNA is sent.              |
| `excludeCookies`     | `DNA_EXCLUDE_COOKIES`    | `''`                                  | Comma-separated cookie names DNA is never sent.                                     |

A `CONFIG` from an earlier copy of this file still works pasted into this
one: `adapterKey` is read as `apiKey`, and `policyWorkerUrl` as `endpoint`.
An earlier copy itself ignores `enabled`; its off switch is an empty
`policyWorkerUrl`.

`ORIGIN` and `ORIGIN_URL` don't exist here: pass-traffic continues to
whatever your zone already routes to.

## What DNA is sent

Every header and cookie on a sampled request, which is what the worker
and Vercel installs already send, and what lets an access rule match on
one. These never travel, whatever you configure:

| Never sent                                                                  | Why                                                    |
| --------------------------------------------------------------------------- | ------------------------------------------------------ |
| `Authorization`, `Proxy-Authorization`                                      | they carry tokens the decision endpoint must not see   |
| the raw `Cookie` header                                                     | cookies travel by name, never as one blob              |
| `cf-access-jwt-assertion`, `cf-access-client-id`, `cf-access-client-secret` | Cloudflare Access's credentials for your own site      |
| `connection`, `transfer-encoding`, `content-length`, `host`                 | the platform owns them; they describe the hop, not you |

Values are capped so the decision call stays bounded: 2 KB per value and
16 KB across them, 256 cookies, and 128 names per list. Anything past a
cap is **named** on the payload rather than dropped silently, so a rule
that checks it is skipped rather than matching on nothing. Our own
`__Host-d3pay` and `__Host-d3person` ride headers of their own and are
not repeated in the cookie map.

Keep your own names back with `excludeHeaders` and `excludeCookies`:

```js
excludeHeaders: 'X-Internal-Key',
excludeCookies: 'session_id, csrf_token',
```

**Cookie names are matched exactly; header names are not.** Headers are
lowercased before the comparison, cookies are compared as your site sets
them — so `excludeCookies: 'Session_ID'` does **not** keep back a cookie
named `session_id`, and that cookie would be sent. Copy the name from
your own `Set-Cookie`.

An excluded name is **declared, not hidden** — DNA is told you kept it
back, so an access rule that checks it is skipped rather than matching
as though the name were absent. That is the difference between a rule
you turned off and a rule that quietly reads `not-exists` on every
request. List more than 128 names of either kind and the snippet logs a
warning, because past that DNA reads _every_ name of that kind a request
lacks as kept back.

Upgrading from a snippet older than `snippet:2.0.0`: the older file sent
a fixed list of headers and two of our own cookies. Set these two
constants before you paste if there is anything on your site DNA should
not see.

## The visitor id

From `snippet:2.0.0`, DNA may set a `__Host-d3visitor` (or
`__Secure-d3visitor`) cookie on your visitors: a random label for one
browser on your site, so returning traffic reads as returning rather
than new. It is minted, never measured — nothing about the request feeds
it — it is scoped to your site alone and cannot be joined across sites,
and it is never an input to an access rule.

It needs this revision because it rides the cookie jar and has no header
of its own: a snippet that sends a fixed list cannot carry one back, so
every visit would read as a first visit.

Your origin never sees it. Like our other cookies it is taken out of
`Cookie` before the origin fetch.

A response that carries any header of ours is narrowed to
`Cache-Control: private` — your origin's freshness directives are kept,
but `public` becomes `private`, so no shared cache can hand one
visitor's id or receipt to the next. A page with no DNA header on it is
untouched.

## Response shape

Every sampled response carries an `x-d3-edge` header: `disabled`,
`pass`, `block`, `fail-open`, `fail-closed`, `payment-required`,
`payment-redirect`, or `payment-stub`. An unsampled request (`sampleRate` below `1`)
returns untouched, with no header at all. A blocked request gets a `403`
with a JSON body:

```json
{ "blocked": true, "ruleId": "…", "tier": "…", "identity": "…" }
```

## Paid routes (D3 Pay)

The snippet carries [D3 Pay](../PROTOCOL.md#paid-routes). If you price a
route in the dashboard, an unpaid request gets the `402` the decision
endpoint hands back — or a `302` to the pay app when a browser is
navigating — and the page is served once the visitor's agent presents a
credential:

- **The credential is forwarded, never parsed.** A `__Host-d3pay`
  cookie travels to the decision endpoint as a `d3pay-session` header of
  its own. A `Payment-Authorization` header or a `?d3pay_handoff=` on
  the URL works the same way for an agent with no cookie jar.
- **A paying request gets its own budget** (`paymentTimeoutMs`, 10 s),
  because settlement happens inside that call.
- **A paying request never falls open.** Whatever `failMode` says, a
  failed decision call on a request carrying a credential answers `502
{"error":"payment_unavailable"}`. The page is priced and the charge
  may already have landed; serving it free is the one wrong answer.
- **A paying request is never left to the sample draw.** `sampleRate`
  does not apply to it — unsampled, someone would have paid for a page
  that was then served to everyone free.
- **Your origin never sees a credential.** The payment headers are
  dropped, every cookie of ours is taken out of `Cookie` (yours are left
  alone), and every `d3pay_*` parameter is removed from the URL before
  the origin fetch — not just the handoff. The receipt and the session
  cookie are added to your origin's own response, `Set-Cookie` appended
  rather than replaced.

This costs no extra subrequest: it is the same decision call, reading a
field it already returns. Nothing changes for a site with no priced
routes.

## Notes

- There is no observe-only switch in the snippet. Observe-only is a
  policy posture: with a `log-only` policy in the dashboard (the
  default), every decision comes back `pass` — traffic is recorded,
  nothing blocks. The snippet just acts on the verdict it's given.
- With `sampleRate` below `1`, most responses carry no `x-d3-edge`
  header, so a plain `curl` is an unreliable install check. Set
  `alwaysSampleSigned: true` and send
  `curl -sI -H 'signature-input: x' https://www.example.com/` — that
  request is guaranteed a decision call and comes back tagged.
- The snippet makes one call per sampled request — the decision call. There is
  no after-response outcome report (Snippets have no `waitUntil`);
  requests are classified and logged at decision time.
- Signed request bodies over 1 MB — an agent uploading a large file,
  which is rare — classify as unverified rather than proven (Snippets
  get 2 MB of memory). If large signed uploads matter to your site, use
  a [worker install](https://ai.d3.com/docs/sdks/cloudflare).
- Tested by [`snippet.spec.ts`](./snippet.spec.ts): `npm test` at the
  repo root.

## Working on it

`snippet.js` is **generated and committed** — paste it, don't edit it.
It is built from [`src/snippet.ts`](./src/snippet.ts) and
[`src/config.js`](./src/config.js), bundled with the shared logic from
`packages/protocol` so the forwarding caps, the credential names and the
payment answer have one implementation rather than a copy that drifts.

```
pnpm generate:snippet    # rebuild and write
pnpm check:snippet       # rebuild and fail on any difference
```

CI runs the check before anything else, so a committed file that no
longer matches its source fails the build. The generator also refuses a
bundle that reaches `node_modules` (a Snippet installs nothing), one
that declares its own `CONFIG` (it would shadow the pasted block), and
one over Cloudflare's 32 KB limit — which is why the output is readable
rather than minified: a file a customer pastes into their own CDN has to
be one they can review.

`snippet.js` is listed among the recipe's files, so **anything that
changes the pasted bytes raises `DNA_ADAPTER`** — a change in
`packages/protocol` as much as one here, because a customer's pasted
copy is frozen at the version they pasted. That also means a bump to
`esbuild` or `prettier` can cascade: regenerate, bump the version in
`src/snippet.ts`, add the build to `proven-mechanisms.json`. Both are
pinned exactly for that reason.
