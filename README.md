# D3 Edge adapters

Install adapters and copy-paste recipes for [D3 Edge](https://ai.d3.com)
bot-auth enforcement. Each directory is self-contained, with its own
README covering install, configuration, and behavior.

Every adapter does the same job in front of your site: extract request
metadata, ask your D3 Edge policy endpoint for a decision, then pass the
request through or answer `403` — failing open if the call errors or
times out, so an outage on our side never takes your site down.

| Directory                                    | What it is                                                                       | Paid routes |
| -------------------------------------------- | -------------------------------------------------------------------------------- | ----------- |
| [`cloudflare-snippet/`](./cloudflare-snippet) | A single pasted file for Cloudflare zones — no Worker deploy (paid plans). Traffic sampling built in, reporting its rate to D3 | Yes |
| [`cloudflare-worker/`](./cloudflare-worker)   | Standalone Worker template fronting a site hosted outside Cloudflare             | Yes |
| [`caddy/`](./caddy)                           | Config-only recipe for Caddy's built-in `forward_auth` — no plugin, no build     | No |
| [`nginx/`](./nginx)                           | Access-phase Lua script for OpenResty / nginx with the Lua module                | Yes |
| [`nginx-auth-request/`](./nginx-auth-request) | Config-only recipe for stock nginx via `auth_request` — no Lua required          | No |

All of them speak one contract, specified in
[`PROTOCOL.md`](./PROTOCOL.md): the decision payload, the response, the
`Content-Digest` rule, and the behavior — fail-open, timeout budget,
`403` shape — an adapter has to get right. Read it to write an adapter
for a platform we don't cover yet, or to see exactly what leaves your
infrastructure.

The last column is [D3 Pay](./PROTOCOL.md#paid-routes), the optional
half of that contract: a site prices a route, and the adapter answers
`402` until the visitor's agent presents a credential. The two
forward-auth recipes cannot carry it — their whole answer is a status
code — so a priced route behind them is served as an ordinary pass, and
each README says so. The worker template carries whatever
`@d3-inc/d3-edge-cloudflare-adapter` carries.

The npm SDKs live in [`packages/`](./packages), beside the recipes:

| Package | npm | What it is |
| --- | --- | --- |
| [`cloudflare-adapter/`](./packages/cloudflare-adapter) | [`@d3-inc/d3-edge-cloudflare-adapter`](https://www.npmjs.com/package/@d3-inc/d3-edge-cloudflare-adapter) | Wrap an existing Worker, or deploy it standalone |
| [`vercel-middleware/`](./packages/vercel-middleware) | [`@d3-inc/d3-edge-vercel-middleware`](https://www.npmjs.com/package/@d3-inc/d3-edge-vercel-middleware) | Vercel Routing Middleware |
| [`protocol/`](./packages/protocol) | not yet published | The payload, decision and report types both SDKs build on |

Full documentation: [ai.d3.com/docs](https://ai.d3.com/docs). Questions:
[hello@d3.com](mailto:hello@d3.com).

## Tests

```sh
pnpm install
pnpm test
```

`pnpm test` runs the recipes' tests and each package's suite. CI also runs
`pnpm format:check`, `pnpm lint`, `pnpm typecheck` and `pnpm build`.

## License

Apache-2.0
