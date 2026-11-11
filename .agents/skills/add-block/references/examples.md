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

POSITIVE: one entry per line, the unit entry in a region.

```ts
export const ApiWorkerBlockLayers = Layer.mergeAll(
  // block:gizmo start
  KnobsKvLive,
  // block:gizmo end
);
```

NEGATIVE: a trailing marker. The lint rule against inline comments rejects it.

```ts
  KnobsKvLive, // block:gizmo
```

NEGATIVE: a collapsed list that holds the unit. It fails with `put KnobsKvLive on its own line`.

```ts
export const ApiWorkerBlockLayers = Layer.mergeAll(SystemLive, KnobsKvLive);
```

## Form 2: a `yield*` statement

POSITIVE: a bare statement, or a call, in `infra/alchemy.run.ts`.

```ts
// block:gizmo start
yield* knobsNamespace(stack, stage);
// block:gizmo end
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
  // block:gizmo start
  .add(KnobsApiGroup);
// block:gizmo end
```

## Form 4: an `as const` array entry

POSITIVE: one entry per line in `tools/knob/registry.ts`.

```ts
export const liveKnobs = [
  logLevelKnob,
  // block:gizmo start
  kvKnob,
  // block:gizmo end
] as const;
```

## Block Layers

POSITIVE: the block's Layer sits in the providers list of `apps/api/src/blocks.ts`. `worker.ts`
provides that list under the handler and middleware layers.

```ts
export const ApiWorkerProviderLayers = Layer.mergeAll(
  // block:gizmo start
  KnobsKvLive,
  // block:gizmo end
);

// worker.ts
const Served = Layer.mergeAll(ApiWorkerHandlerGroupLayers, ApiWorkerMiddlewareLayers).pipe(
  Layer.provideMerge(ApiWorkerProviderLayers),
);
```

NEGATIVE: the Layer in the middleware `Layer.mergeAll`. A sibling in one `mergeAll` cannot provide a
service to its siblings.

POSITIVE: a resource the Layer reads is bound in `worker.ts` initialization, like `AppDb`.

```ts
const kv = yield* Cloudflare.KV.Namespace("KnobsKv");
```

## A shared configuration line

POSITIVE: wrap it in the region form, on its own lines.

```ts
// block:gizmo start
ignores: ["packages/knobs-kv/dist"],
// block:gizmo end
```

NEGATIVE: a unit name that starts like another's only works because the match ends at a character
outside `a-z0-9-`; `block:<unit>` never matches `block:<unit>-extra`. Still, do not give two
units names that start the same way.

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
