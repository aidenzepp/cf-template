import { BunServices } from "@effect/platform-bun";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { removeMarked } from "./markers.ts";

/**
 * Reads the `.txt` fixture `name` from `tools/blocks/fixtures/`.
 */
const fixture = Effect.fn("markers.test.fixture")(function* fixture(name: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  return yield* fs.readFileString(
    yield* path.fromFileUrl(new URL(`fixtures/${name}.txt`, import.meta.url)),
  );
});

it.effect("a line ending in a block:fixture-unit marker is removed, near misses are left", () =>
  Effect.gen(function* lines() {
    const text = yield* fixture("marked-lines");

    assert.strictEqual(
      yield* removeMarked("fixture-unit", "marked-lines", text),
      [
        "const kept = 1;",
        "const extra = 4; // block:fixture-unit-extra",
        'const named = "fixture-unit";',
        "",
      ].join("\n"),
    );
  }).pipe(Effect.provide(BunServices.layer)),
);

it.effect("a block:fixture-unit start to end region is removed with both lines", () =>
  Effect.gen(function* region() {
    const text = yield* fixture("marked-region");

    assert.strictEqual(
      yield* removeMarked("fixture-unit", "marked-region", text),
      "before\nafter\n",
    );
  }).pipe(Effect.provide(BunServices.layer)),
);

it.effect("a region with a start and no end fails naming its file and line", () =>
  Effect.gen(function* unterminated() {
    const text = yield* fixture("unterminated-region");

    const error = yield* Effect.flip(removeMarked("fixture-unit", "unterminated-region", text));

    assert.strictEqual(
      error.message,
      "unterminated block:fixture-unit region unterminated-region:2",
    );
  }).pipe(Effect.provide(BunServices.layer)),
);
