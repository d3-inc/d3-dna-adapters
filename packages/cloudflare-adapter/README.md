# @d3-inc/d3-dna-cloudflare-adapter

The [DNA](https://ai.d3.com) middleware for Cloudflare Workers. In front of
your site, it extracts the signature headers, user agent, and IP from each
request, asks the DNA policy endpoint for a decision, enforces it, and forwards allowed traffic to your
origin — failing open if the policy call errors or times out, so an outage
never takes down your site.

## Install

```sh
npm i @d3-inc/d3-dna-cloudflare-adapter
```

Versions up to 0.9.0 were published as `@d3-inc/d3-edge-cloudflare-adapter`. To switch, change the package
name in `package.json` and in your import; nothing else changes.

## Usage — your site is already a Worker

Wrap your existing handler. One line, no second worker, no route changes:

```ts
// src/index.ts
import { withD3Edge } from '@d3-inc/d3-dna-cloudflare-adapter';

export default withD3Edge({
  async fetch(request, env, ctx) {
    // your existing worker, unchanged
  },
});
```

Blocked requests get a `403` before your `fetch` runs; everything else
reaches it as before. Non-fetch handlers (`scheduled`, `queue`, …) pass
through untouched. `ORIGIN`/`ORIGIN_URL` are not needed; the wrapped
handler is the origin.

## Usage — external origin

Origin not on Workers (nginx, a VPS, another cloud)? The
[Deploy to Cloudflare button](https://ai.d3.com/docs/sdks/cloudflare#the-deploy-button)
sets this shape up from the browser, no code. By hand, deploy the adapter
as a standalone worker on a zone route:

```ts
// src/index.ts
import worker from '@d3-inc/d3-dna-cloudflare-adapter';

export default worker;
```

```toml
# wrangler.toml
name = "my-site-d3-edge"
main = "src/index.ts"
compatibility_date = "2025-06-01"

# Zone route: your DNS record stays as-is; pass-traffic flows to your origin.
routes = [{ pattern = "www.example.com/*", zone_name = "example.com" }]
```

Origin a Worker you can't edit, or a Pages project? Attach the standalone
worker with `custom_domain = true` and an `ORIGIN` service binding instead —
a custom domain replaces the hostname's DNS record, so it always needs
`ORIGIN` (or `ORIGIN_URL`) to reach the origin. The
[docs](https://ai.d3.com/docs/sdks/cloudflare) cover every shape.

With either shape, set your org's API key (from the API keys page of your
DNA dashboard) as a secret. It is the only setting DNA needs:

```sh
npx wrangler secret put DNA_API_KEY
```

Without it the worker is a pure passthrough (no enforcement, no reporting);
`DNA_ENABLED = "false"` does the same with the key in place. The exported
`Env` type documents every variable, and the
[docs](https://ai.d3.com/docs/sdks/cloudflare#earlier-variable-names) map the
earlier `POLICY_*` names, which are still read.

## Usage — no Worker at all: a Snippet

On a paid Cloudflare plan you can paste a single-file
[Snippet](https://ai.d3.com/docs/sdks/cloudflare#paste-a-snippet) into your
zone instead of deploying a Worker — same enforcement, no npm install (the
file can't import this package; Snippets have no dependencies). The pasteable
file lives in
[d3-dna-adapters](https://github.com/d3-inc/d3-dna-adapters/tree/main/cloudflare-snippet),
tested there.

## What reaches the origin

Only two cookies leave the site for the policy worker, each under its own
header: `__Host-d3pay` (a DNA session) and `__Host-d3person` (a browser-check
pass). On an enforced pass the origin sees neither, nor a `d3pay_handoff`,
`d3pay_check` or `d3pay_browser` query parameter: the adapter strips them before
the fetch and appends `Set-Cookie` and `Payment-Receipt` to the response on the
way back.

Three paths never strip, and hand the origin the request as it arrived: DNA
switched off (passthrough), an ACME challenge, and fail-open after the
policy call fails.

The policy call carries what Cloudflare saw of the connection, from `request.cf`
on every plan: ASN and organisation, country, HTTP protocol, TLS version and
cipher, ClientHello length, extension and cipher hashes, TCP RTT. From 0.8.0 it
also carries the browser's client hints (`sec-ch-ua`, `sec-ch-ua-platform`,
`sec-ch-ua-mobile`) and `accept-language`. They are logged on the request
record for analysis and decide nothing.

## Docs

Full documentation, including origin binding options and the decision model:
[ai.d3.com/docs](https://ai.d3.com/docs).

## License

Apache-2.0
