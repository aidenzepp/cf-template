import { BunServices } from "@effect/platform-bun";
import { assert, it } from "@effect/vitest";
import { Effect, Path } from "effect";

import { decodeManifest, readManifest, withoutUnit } from "./manifest.ts";

it.effect("a one-block manifest decodes and the entry removal leaves no line naming it", () =>
  Effect.gen(function* removal() {
    const path = yield* Path.Path;

    const real = yield* readManifest(
      yield* path.fromFileUrl(new URL("../../blocks.json", import.meta.url)),
    );

    const block = { name: "fixture-unit", paths: ["packages/fixture-unit"] };
    const text = JSON.stringify({ ...real, blocks: [block] }, null, 2);
    const decoded = yield* decodeManifest(text);

    assert.deepStrictEqual(decoded.blocks, [block]);
    assert.isTrue(text.includes("fixture-unit"));

    const removed = JSON.stringify(withoutUnit(decoded, "fixture-unit"), null, 2);

    assert.isFalse(removed.split("\n").some((line) => line.includes("fixture-unit")));
    assert.deepStrictEqual(decoded.slices, real.slices);
  }).pipe(Effect.provide(BunServices.layer)),
);
