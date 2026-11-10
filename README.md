# D3 Edge adapters

Install adapters and copy-paste recipes for [D3 Edge](https://ai.d3.com)
bot-auth enforcement. Each directory is self-contained, with its own
README covering install, configuration, and behavior.

Every adapter does the same job in front of your site: extract request
metadata, ask your D3 Edge policy endpoint for a decision, then pass the
request through or answer `403` — failing open if the call errors or
times out, so an outage on our side never takes your site down.

| Directory                                     | What it is                                                                                           | Paid routes |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------- |
| [`cloudflare-snippet/`](./cloudflare-snippet) | A single pasted file for Cloudflare zones — no Worker deploy (paid plans). Traffic sampling built in | Yes         |
| [`cloudflare-worker/`](./cloudflare-worker)   | Standalone Worker template fronting a site hosted outside Cloudflare                                 | Yes         |
| [`caddy/`](./caddy)                           | One importable file for stock Caddy 2.8+: no plugin, no build                                        | Yes         |
| [`nginx/`](./nginx)                           | Two includes for OpenResty: every rule, any header or cookie, MCP calls charged per call             | Yes         |
| [`nginx-auth-request/`](./nginx-auth-request) | Config-only recipe for stock nginx via `auth_request` — no Lua required                              | No          |

All of them speak one contract, specified in
[`PROTOCOL.md`](./PROTOCOL.md): the decision payload, the response, the
`Content-Digest` rule, and the behavior — fail-open, timeout budget,
`403` shape — an adapter has to get right. Read it to write an adapter
for a platform we don't cover yet, or to see exactly what leaves your
infrastructure.

The last column is [D3 Pay](./PROTOCOL.md#paid-routes), the optional
half of that contract: a site prices a route, and the adapter answers
`402` until the visitor's agent presents a credential. Behind nginx
`auth_request`, a priced route is served as an ordinary page, because nginx
keeps only the answer's status. The worker template carries whatever the
Cloudflare adapter it installs carries.

The npm SDKs live in [`packages/`](./packages), beside the recipes:

| Package                                                | npm                                                                                                    | What it is                                                |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| [`cloudflare-adapter/`](./packages/cloudflare-adapter) | [`@d3-inc/d3-dna-cloudflare-adapter`](https://www.npmjs.com/package/@d3-inc/d3-dna-cloudflare-adapter) | Wrap an existing Worker, or deploy it standalone          |
| [`vercel-middleware/`](./packages/vercel-middleware)   | [`@d3-inc/d3-dna-vercel-middleware`](https://www.npmjs.com/package/@d3-inc/d3-dna-vercel-middleware)   | Vercel Routing Middleware                                 |
| [`protocol/`](./packages/protocol)                     | [`@d3-inc/d3-dna-protocol`](https://www.npmjs.com/package/@d3-inc/d3-dna-protocol)                     | The payload, decision and report types both SDKs build on |

The SDKs took these names at 0.10.0. Earlier versions are
`@d3-inc/d3-edge-cloudflare-adapter` and `@d3-inc/d3-edge-vercel-middleware`, which
get no new versions.

Full documentation: [ai.d3.com/docs](https://ai.d3.com/docs). Questions:
[hello@d3.com](mailto:hello@d3.com).

## Tests

```sh
pnpm install
pnpm test
```

`pnpm test` runs the recipes' tests and each package's suite. CI also runs
`pnpm format:check`, `pnpm lint`, `pnpm typecheck` and `pnpm build`.

## Releases

CI publishes all three packages at one version from a tag on `main`, with npm
provenance naming this repo and `publish.yml`:

- `vX.Y.Z-next.N` publishes a prerelease to `next`, which only
  `npm i <package>@next` installs.
- `vX.Y.Z` publishes to `latest`.
- A fix for an older line is tagged on a `release/X.Y` branch and publishes
  under `release-X.Y`.

Each run waits for a reviewer other than the person who tagged it. Each name's
first version, 0.10.0, is published by hand from that tag's CI tarballs, because
npm attaches a trusted publisher only to a package that already exists.
Provenance starts at 0.10.1.

## License

Apache-2.0
