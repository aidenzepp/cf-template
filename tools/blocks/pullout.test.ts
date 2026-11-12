import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";

import { trimPackages } from "./pullout.ts";
import type { Pkg, Unit } from "./pullout.ts";

/**
 * A unit that owns `miniflare` of `apps/api/package.json` and `@scope/tool` of the root manifest,
 * and deletes no file.
 */
const unit: Unit = {
  doomed: () => false,
  keep: [],
  name: "widgets",
  owned: [
    { manifest: "apps/api/package.json", name: "miniflare" },
    { manifest: "package.json", name: "@scope/tool" },
  ],
  packageName: undefined,
  tree: "tree",
};

/**
 * The root manifest and one workspace manifest, each listing the owned dependency and a kept one.
 */
const packages: ReadonlyArray<Pkg> = [
  { dir: ".", json: { devDependencies: { "@scope/tool": "1.0.0", effect: "4.1.2" } } },
  { dir: "apps/api", json: { devDependencies: { effect: "4.1.2", miniflare: "4.0.0" } } },
];

/**
 * Runs `trimPackages` over an in-memory tree that holds `packages`, and returns the files it wrote.
 */
const trimmed = (listed: ReadonlyArray<Pkg>) =>
  Effect.gen(function* trim() {
    const written = new Map<string, string>();

    const files = FileSystem.layerNoop({
      readFileString: (file) =>
        Effect.succeed(
          JSON.stringify(
            listed.find(
              (pkg) => `tree/${pkg.dir === "." ? "" : `${pkg.dir}/`}package.json` === file,
            )?.json ?? {},
          ),
        ),
      writeFileString: (file, text) =>
        Effect.sync(() => {
          written.set(file, text);
        }),
    });

    const changed = yield* trimPackages(unit, packages).pipe(Effect.provide(files));

    return { changed, written };
  }).pipe(Effect.provide(Path.layer));

describe("trimPackages", () => {
  it.effect("drops an owned dependency from the root manifest and from a workspace manifest", () =>
    Effect.gen(function* both() {
      const { changed, written } = yield* trimmed(packages);

      assert.deepStrictEqual(changed, ["package.json", "apps/api/package.json"]);

      assert.deepStrictEqual(JSON.parse(written.get("tree/package.json") ?? ""), {
        devDependencies: { effect: "4.1.2" },
      });

      assert.deepStrictEqual(JSON.parse(written.get("tree/apps/api/package.json") ?? ""), {
        devDependencies: { effect: "4.1.2" },
      });
    }),
  );

  it.effect("fails naming the manifest when an owned dependency is not listed", () =>
    Effect.gen(function* absent() {
      const result = yield* Effect.flip(
        trimPackages(unit, [
          packages[0] ?? { dir: ".", json: {} },
          { dir: "apps/api", json: { devDependencies: { effect: "4.1.2" } } },
        ]).pipe(Effect.provide(Layer.mergeAll(Path.layer, FileSystem.layerNoop({})))),
      );

      assert.include(result.message, "miniflare");
      assert.include(result.message, "apps/api/package.json");
    }),
  );
});
