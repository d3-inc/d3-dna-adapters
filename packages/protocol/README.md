# @d3-inc/d3-dna-protocol

The wire contract between DNA's SDKs and its decision endpoint: the request payload, the decision,
the response report, and the adapter helpers built on them. It holds no server logic and no secrets.
[`PROTOCOL.md`](https://github.com/d3-inc/d3-dna-adapters/blob/main/PROTOCOL.md) specifies it.

[`@d3-inc/d3-dna-cloudflare-adapter`](https://www.npmjs.com/package/@d3-inc/d3-dna-cloudflare-adapter)
and [`@d3-inc/d3-dna-vercel-middleware`](https://www.npmjs.com/package/@d3-inc/d3-dna-vercel-middleware)
depend on it at their own version. Install it directly only to write an adapter for another platform.

## License

Apache-2.0
