---
name: add-feature
description: Add a feature slice that declares no Cloudflare resource and adds no Worker. Use when adding a contract module, an `api` service with its handlers, and `web` route files for one feature, such as a new list-and-detail screen over the existing app database. A slice that declares a resource or adds a Worker is `add-block`'s.
---

# Add Feature

A feature slice is the contract module, the `api` service and the `web` route files for one
feature, all of them over resources that already exist. The slice owns its own folders and touches
the shared files in a few single lines, so removing it later is deleting its paths and those lines.
A unit that declares a resource (a database, a bucket, a queue) or adds a Worker is not a slice; use
the `add-block` skill for it.

Before writing, read [references/examples.md](references/examples.md). It shows the four attach
forms as code, one example each, and the `exports` edit as a diff.

## Procedure

1. Name the slice and its paths: the contract module under `packages/contract/src/domain/<slice>/`,
   the `api` feature folder `apps/api/src/<slice>/`, and the `web` route files under
   `apps/web/src/routes/<slice>/` with their colocated `-atoms.ts`.
2. Write the contract first: the request and response Schemas, and the Problem classes the slice
   returns. The `api` and `web` code both import these; neither redefines a shape.
3. Write the `api` service and its layer, then attach it with one of the four attach forms below.
   Everything else lives in the slice's own folder.
4. Add the `packages/contract/package.json` `exports` entry for each new domain module, one subpath
   per module and no barrel. Add the `web` route's `exports` entry only if the slice exports a
   shared module.
5. Write the `web` route files and the atoms. Run `bun run build` so the router plugin regenerates
   `apps/web/src/route-tree.gen.ts`; never edit that file by hand.
6. Add the tests beside the code: the contract's Schema tests, the service's `it.effect` cases and
   the route's harness case. Then run `bun run check`, then `bun run test`.
7. To remove the slice later (the attach lines, the `exports` entries whose target lies under a
   deleted path, and the leftover scan), follow the `add-block` skill; this skill does not restate
   it.

## The four attach forms

A slice adds one attach line per attach file, and nothing else in that file.

- A `Layer.provide` line in the Worker's layer composition, for a service the handlers need.
- A `.add(...)` line on the `HttpApi` group list in the contract's `api.ts`, for the slice's group.
- An entry in the multi-line `Layer.mergeAll(` of the services layer, one entry per line, for the
  slice's handler layer.
- One entry appended to a named core `as const` array, for a registry the attach-file list names.

## Limits to keep

- A list endpoint is unpaged by design. The per-user quota bounds how many rows a caller can hold,
  so a slice that adds a list returns every row the caller owns and adds no paging.
- There is no cascade across databases. An app slice never references the auth database's tables:
  it stores the owner's id as a plain column with no foreign key and reads it from `CurrentUser`.
