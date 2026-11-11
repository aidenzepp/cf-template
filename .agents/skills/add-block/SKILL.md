---
name: add-block
description: Add a removable block (a package that declares a Cloudflare resource or adds a Worker) and attach it to core. Use when a change adds a Cloudflare resource or a Worker, edits blocks.json, a blocks.ts attach file or a package README Meter line, or when `bun run footprint` or `bun run pullout` fails.
---

# Add Block

A unit is code that must come out cleanly. Core may name a unit only on an attach line: one import
and one entry in an attach file. Any other reference from core is a dependent, and
`bun run footprint` fails on it.

Before writing, read [references/examples.md](references/examples.md). It shows each form below
with a real attach file.

## Block or slice

- A block declares a Cloudflare resource or adds a Worker. It is its own package under `packages/`.
- A slice is application code inside an app that can be removed (a feature). A slice is not a
  block: it has no package and no `Meter:` line, and it gets a `slices` entry in `blocks.json`.
- Vendored code in `packages/ui` is never a block.

## Package

1. Run `bun install` in your own worktree before any package script. A worktree has its own
   `node_modules`; scripts run against the main checkout's install can pass for the wrong reason.
2. Create `packages/<name>/package.json` with one `exports` subpath per module and no barrel
   (`"./live": "./src/live.ts"`, not an `index.ts` that re-exports). Export only the subpaths the
   change needs; a block that ships a Layer exports `./live` and nothing wider.
3. Put `Meter:` alone on the first line of `packages/<name>/README.md`. Write exactly one of:
   - `Meter: none`
   - `Meter: ` then a comma-separated list from `Workers requests`, `CPU ms`, `KV`, `D1`, `R2`,
     `Queues`, `Durable Objects`, `Workflows`, `Secrets Store`
   - `Meter: UNKNOWN (<reason>)`, when the provider has not published what the resource bills
4. A block whose code is not all in `packages/<name>/` gets a `blocks` entry in `blocks.json`:
   `{ "name": "<name>", "paths": [...] }`. A block with no entry is its package directory.

## Attach

An attach file is listed in `blocks.json` under `attachFiles`. In one, write one entry per line,
and end each unit entry with `// block:<unit>`. The four forms are:

1. An entry of a multi-line `Layer.mergeAll(`.
2. A bare `yield* X;` statement in `infra/alchemy.run.ts`.
3. An `.add(X)` link in a core list.
4. An entry of a multi-line `as const` array named in `attachFiles`.

Collapsed lines. The formatter may collapse a short `Layer.mergeAll(A, B)` onto one line. A
collapsed list of core names only is read as is. A collapsed list that holds a unit fails with
`put <unit> on its own line with // block:<unit>`: split it, one entry per line. A line in an attach
file that fits none of the forms fails with `unknown attach shape <file>:<line>`; rewrite it into a
form.

## Shared configuration lines

A line a block needs that is not an attach line (a Vitest project, an ignore entry) ends in
`// block:<unit>` and the pull-out deletes it. For several lines, wrap them: a line holding
`block:<unit> start`, the lines, then a line holding `block:<unit> end`. Never put a marker in a
JSON file; the pull-out edits `package.json` `exports`, dependencies and `blocks.json` itself.

## Check the work

- `bun run footprint` prints one line per unit and fails on any core reference outside an attach
  line.
- `bun run pullout <unit>` removes the unit in a throwaway worktree and runs the gates there. It
  needs a clean tree and tests `HEAD`, so commit first. Its error messages name the file and the
  reason.
