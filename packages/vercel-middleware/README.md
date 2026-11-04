# @d3-inc/d3-edge-vercel-middleware

The [DNA](https://ai.d3.com) middleware for Vercel, as Routing Middleware. On
every request it extracts the signature headers, user agent, and IP, asks the DNA policy endpoint for a decision, and passes or blocks
accordingly — failing open if the policy call errors or times out, so an
outage never takes down your site.

## Install

```sh
npm i @d3-inc/d3-edge-vercel-middleware
```

## Usage

```ts
// middleware.ts (project root)
import { createD3Middleware, config } from '@d3-inc/d3-edge-vercel-middleware';

export default createD3Middleware();
export { config };
```

Set one project environment variable, `DNA_API_KEY`, to your org's API key
(`d3_k_…`, from the API keys page of your DNA dashboard).

Without it the middleware is a pure passthrough (no enforcement, no
reporting); `DNA_ENABLED=false` does the same with the key in place. The
[docs](https://ai.d3.com/docs/sdks/vercel#configuration) list every setting and
map the earlier `POLICY_*` names, which are still read.

## What reaches the origin

Only two cookies leave the site for the policy worker, each under its own
header: `__Host-d3pay` (a DNA session) and `__Host-d3person` (a browser-check
pass). On an enforced pass the site sees neither, nor a `d3pay_handoff`,
`d3pay_check` or `d3pay_browser` query parameter: the middleware strips them
before `next()` (rewriting when the URL changed) and appends `Set-Cookie` and
`Payment-Receipt` to the response on the way back.

Two paths never strip, and continue the request as it arrived: DNA
switched off (passthrough) and fail-open after the policy call fails.

The policy call carries the visitor's country, read with `geolocation()` from
Vercel's own header, and from 0.7.0 the browser's client hints and
`accept-language`; they are logged on the request record and decide nothing.

## Docs

Full documentation, including config options and the decision model:
[ai.d3.com/docs](https://ai.d3.com/docs).

## License

Apache-2.0
