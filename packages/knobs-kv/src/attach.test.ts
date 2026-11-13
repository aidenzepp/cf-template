import { BunServices } from "@effect/platform-bun";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Schema } from "effect";

/**
 * The Workers that read a live knob: every one of them lists `KnobsKvLive` in its `blocks.ts`.
 */
const WORKERS = ["api", "auth", "web"] as const;

/**
 * An exported layer whose definition names `KnobsKvLive`, alone or among the entries of a
 * `Layer.mergeAll`.
 */
const ENTRY = /^export const \w+ =[^;]*\bKnobsKvLive\b/mu;

/**
 * The fields of this package's `package.json` the export test reads.
 */
const PackageJson = Schema.Struct({ exports: Schema.Record(Schema.String, Schema.String) });

/**
 * Read a file next to the workspace root, given its path relative to this file.
 */
const read = Effect.fn("knobs-kv.test.read")(function* read(relative: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  return yield* fs.readFileString(yield* path.fromFileUrl(new URL(relative, import.meta.url)));
});

it.effect.each(WORKERS)("attaches KnobsKvLive to the %s Worker", (worker) =>
  Effect.gen(function* attached() {
    const blocks = yield* read(`../../../apps/${worker}/src/blocks.ts`);

    assert.isTrue(ENTRY.test(blocks), `apps/${worker}/src/blocks.ts has no KnobsKvLive entry`);
  }).pipe(Effect.provide(BunServices.layer)),
);

it.effect("exports only ./live", () =>
  Effect.gen(function* exported() {
    const manifest = yield* Schema.decodeEffect(Schema.fromJsonString(PackageJson))(
      yield* read("../package.json"),
    );

    assert.deepStrictEqual(Object.keys(manifest.exports), ["./live"]);
  }).pipe(Effect.provide(BunServices.layer)),
);
