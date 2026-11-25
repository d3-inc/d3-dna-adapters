# d3-dna-adapters: authoring standards

This repo is code that runs on customers' sites. The SDKs in `packages/` fail
open and strip headers before a request reaches the site's origin, and an npm
release reaches every site that installs or updates them. Changes must arrive
shaped for a human reviewer.

## The rules that bind here

- **A human must be able to read the change.** Cohesive, clearly named, no
  cleverness a reviewer has to reverse-engineer.
- **Security-relevant logic is a named, unit-tested function, never inline.** A
  header strip, a size cap, a fail-open or fail-closed branch, or anything built
  from a visitor's input gets its own name and a test that pins the reject path.
- **A behaviour change carries a test that fails before it and passes after.**
- **Never break a deployed install.** Every published SDK version and every
  pasted recipe keeps running on sites we cannot upgrade. A change to
  `packages/protocol` or `PROTOCOL.md` must keep the policy worker answering the
  versions already out there.
- **A contract change merges here first.** The worker then takes it in a pinned
  bump of this repo.
- **Correct over quick.** Fix the root cause, not the symptom.

## Packages

- `packages/protocol` is the wire contract. It may import only its own files and
  the dependencies its `package.json` declares.
- Pin dependency versions in each `package.json`. This repo installs alone, so
  there is no shared catalog.

## Before you push

```sh
pnpm install
pnpm check:snippet && pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

## Comments

A comment carries what the code cannot: a reason, a constraint, a measurement,
or a bug that was hit. Delete one the code already says. One line by default.
