import { BunServices } from "@effect/platform-bun";
import { assert, describe, it } from "@effect/vitest";
import { Array, Effect, FileSystem, Order, Path } from "effect";

/**
 * Every `*.model.ts` file under the `src` directory of each `apps/*` and `packages/*` workspace
 * with no `*.story.ts` of the same stem beside it, as paths relative to `root`.
 *
 * @param root - The repository root.
 * @returns The model files that have no Story file.
 */
const unpairedModels = (root: string) =>
  Effect.gen(function* findUnpaired() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const groups = yield* Effect.forEach(["apps", "packages"], (group) =>
      fs
        .readDirectory(path.join(root, group))
        .pipe(Effect.map((names) => names.map((name) => path.join(group, name, "src")))),
    );

    const listed = yield* Effect.forEach(Array.flatten(groups), (src) =>
      fs.readDirectory(path.join(root, src), { recursive: true }).pipe(
        Effect.map((entries) => entries.map((entry) => path.join(src, entry))),
        // A workspace with no `src` directory holds no model file.
        Effect.orElseSucceed(() => []),
      ),
    );

    const files = new Set(Array.flatten(listed));

    return Array.sort(
      [...files].filter(
        (file) =>
          file.endsWith(".model.ts") && !files.has(file.replace(/\.model\.ts$/u, ".story.ts")),
      ),
      Order.String,
    );
  });

/**
 * The repository root, one directory above this file.
 */
const repositoryRoot = Effect.gen(function* locateRoot() {
  const path = yield* Path.Path;

  return yield* path.fromFileUrl(new URL("..", import.meta.url));
});

describe("Domain models and their Stories", () => {
  it.effect("pair every model file with a Story file beside it", () =>
    Effect.gen(function* pairing() {
      const root = yield* repositoryRoot;
      const unpaired = yield* unpairedModels(root);

      assert.deepStrictEqual(unpaired, [], "A *.model.ts file has no *.story.ts beside it.");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("finds the notes model paired with notes.story.ts", () =>
    Effect.gen(function* known() {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* repositoryRoot;

      assert.isTrue(yield* fs.exists(`${root}/apps/api/src/notes/notes.model.ts`));
      assert.isTrue(yield* fs.exists(`${root}/apps/api/src/notes/notes.story.ts`));
    }).pipe(Effect.provide(BunServices.layer)),
  );
});
