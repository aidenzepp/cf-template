import { BunServices } from "@effect/platform-bun";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { checkLock, componentsDirectory, diffLock, hashFiles, lockFile, readTree } from "./lock.ts";

const encoder = new TextEncoder();

/**
 * The repository root, two directories above this file.
 */
const root = Effect.fn("ui-lock.test.root")(function* root() {
  const path = yield* Path.Path;

  return yield* path.fromFileUrl(new URL("../../", import.meta.url));
});

/**
 * The committed tree as bytes, and the lines `diffLock` reports for `change` applied to it.
 */
const differences = Effect.fn("ui-lock.test.differences")(function* differences(
  change: (files: Record<string, Uint8Array>) => Record<string, Uint8Array>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const base = yield* root();
  const tree = yield* readTree(path.join(base, componentsDirectory));
  const expected = yield* hashFiles(tree);
  const text = yield* fs.readFileString(path.join(base, lockFile));

  assert.deepStrictEqual(JSON.parse(text), expected);

  return diffLock(expected, yield* hashFiles(change(tree)));
});

it.effect("passes on the committed tree", () =>
  Effect.gen(function* passes() {
    const path = yield* Path.Path;
    const base = yield* root();

    yield* checkLock(path.join(base, componentsDirectory), path.join(base, lockFile));
  }).pipe(Effect.provide(BunServices.layer)),
);

it.effect("fails when one class in a file is edited", () =>
  Effect.gen(function* edited() {
    const found = yield* differences((files) => ({
      ...files,
      "button.tsx": encoder.encode(`${new TextDecoder().decode(files["button.tsx"])} text-xs`),
    }));

    assert.deepStrictEqual(found, ["edited: button.tsx"]);
  }).pipe(Effect.provide(BunServices.layer)),
);

it.effect("fails when a file is deleted", () =>
  Effect.gen(function* deleted() {
    const found = yield* differences(({ "card.tsx": _card, ...rest }) => rest);

    assert.deepStrictEqual(found, ["removed: card.tsx"]);
  }).pipe(Effect.provide(BunServices.layer)),
);

it.effect("fails when a file is added", () =>
  Effect.gen(function* added() {
    const found = yield* differences((files) => ({
      ...files,
      "extra.tsx": encoder.encode("export {};"),
    }));

    assert.deepStrictEqual(found, ["added: extra.tsx"]);
  }).pipe(Effect.provide(BunServices.layer)),
);
