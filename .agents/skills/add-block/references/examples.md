# Add Block Examples

Each example pairs one rule with a block called `knobs-kv`. `POSITIVE` is the practice to follow.
`NEGATIVE` is what to avoid.

## The README first line

POSITIVE: the first line of `packages/knobs-kv/README.md` names what the block bills.

```md
Meter: KV, Workers requests
```

POSITIVE: an unpublished price is declared, with the reason.

```md
Meter: UNKNOWN (pricing unpublished)
```

NEGATIVE: a title first, or a meter outside the list. Both fail the grammar.

```md
# knobs-kv

Meter: Key-Value store
```

## Exports

POSITIVE: one subpath per module, and only the ones the change needs.

```json
"exports": {
  "./live": "./src/live.ts"
}
```

NEGATIVE: a barrel. Importers reach every module, and the pull-out cannot see which one they use.

```json
"exports": {
  ".": "./src/index.ts"
}
```

## Form 1: a `Layer.mergeAll(` entry

POSITIVE: one entry per line, the unit entry marked.

```ts
export const ApiWorkerMiddlewareLayers = Layer.mergeAll(
  SessionMiddlewareLive,
  KnobsKvLive, // block:knobs-kv
);
```

NEGATIVE: a collapsed list that holds the unit. It fails with
`put KnobsKvLive on its own line with // block:knobs-kv`.

```ts
export const ApiWorkerMiddlewareLayers = Layer.mergeAll(SessionMiddlewareLive, KnobsKvLive);
```

## Form 2: a `yield*` statement

POSITIVE: a bare statement in `infra/alchemy.run.ts`.

```ts
yield* KnobsKv; // block:knobs-kv
```

NEGATIVE: the tail of an assignment. It is not an attach line, so it fails as an unknown shape.

```ts
const kv =
  yield* KnobsKv;
```

## Form 3: an `.add(X)` link

POSITIVE: one link per line in the core list.

```ts
export const Api = HttpApi.make("api")
  .add(SystemApiGroup)
  .add(KnobsApiGroup); // block:knobs-kv
```

## Form 4: an `as const` array entry

POSITIVE: one entry per line in `tools/knob/registry.ts`.

```ts
export const liveKnobs = [
  logLevelKnob,
  kvKnob, // block:knobs-kv
] as const;
```

## A shared configuration line

POSITIVE: a one-line entry ends in the marker; several lines use the region form.

```ts
ignores: ["packages/knobs-kv/dist"], // block:knobs-kv
```

```ts
// block:knobs-kv start
{ extends: ["vitest"], name: "knobs-kv", root: "packages/knobs-kv" },
// block:knobs-kv end
```

NEGATIVE: a marker that is a prefix of another unit's name only works because the match ends at a
character outside `a-z0-9-`; `block:knobs-kv` never matches `block:knobs-kv-extra`. Still, do not
give two units names that start the same way.

## A block with code in several places

POSITIVE: list every path in the `blocks` entry of `blocks.json`.

```json
"blocks": [
  { "name": "knobs-kv", "paths": ["packages/knobs-kv/", "apps/api/src/knobs-kv/"] }
]
```

## Worktrees

POSITIVE: install first, then check.

```sh
cd .worktrees/add-knobs-kv
bun install
bun run footprint
```

NEGATIVE: run `bun run footprint` in a fresh worktree with no install. The result reflects the
wrong dependency tree.
