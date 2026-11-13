# D3 Edge worker, devnet

For D3 staff. This is [`cloudflare-worker/`](../cloudflare-worker) with one
difference: it asks D3's internal devnet for decisions, not production. A
production key does not work here, and the worker then passes all traffic.

Customers use [`cloudflare-worker/`](../cloudflare-worker).

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/d3-inc/d3-dna-adapters/tree/main/cloudflare-worker-devnet)

The deploy flow asks for one secret, `DNA_API_KEY`. Create the key at
[dashboard-dev.d3.com/keys](https://dashboard-dev.d3.com/keys) first.

After the deploy, attach a route and check the install as the
[customer README](../cloudflare-worker/README.md#after-deploying-connect-your-site)
describes.

## Keeping it in step

`scripts/devnet-template.spec.ts` fails when this directory differs from
`cloudflare-worker/` in anything but the endpoint, the worker name, the key
link and this file. A change to the customer template is made in both.
