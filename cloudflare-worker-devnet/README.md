# D3 Edge worker, devnet

For D3 staff. This is the
[customer template](https://github.com/d3-inc/d3-dna-adapters/tree/main/cloudflare-worker)
with one difference: it asks D3's internal devnet for decisions, not
production. A production key does not work here: the worker then passes
traffic, and answers `502` to a request that presents a payment.

Customers use the customer template.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/d3-inc/d3-dna-adapters/tree/main/cloudflare-worker-devnet)

The deploy flow asks for one secret, `DNA_API_KEY`. Create the key at
[dashboard-dev.d3.com/keys](https://dashboard-dev.d3.com/keys) first.

## After deploying: connect your site

The worker serves nothing until you attach it. In the Cloudflare dashboard:
**Workers & Pages → your worker → Settings → Domains & Routes**, add a route
like `www.example.com/*`.

Check it with `curl -sI https://www.example.com/`: every response carries an
`x-d3-edge` header once the worker is attached.

## Keeping it in step

[`scripts/devnet-template.spec.ts`](https://github.com/d3-inc/d3-dna-adapters/blob/main/scripts/devnet-template.spec.ts)
fails when this directory differs from the customer template in anything but
the endpoint, the worker name, the key link and this file. A change to the
customer template is made in both.
