import { BunServices } from "@effect/platform-bun";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Schema } from "effect";

/**
 * The packages that ship as one set and are bumped together: `@alchemy.run/domain` requires
 * `alchemy` at its own exact version, and `@alchemy.run/cloudflare` hosts the Domain model.
 */
const LOCKSTEP = ["@alchemy.run/domain", "alchemy", "@alchemy.run/cloudflare"] as const;

/**
 * The dependency maps of a `package.json`.
 */
const Manifest = Schema.Struct({
  dependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  devDependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});

/**
 * Every `name@range` the root and workspace manifests declare for a lockstep package.
 */
const declaredVersions = Effect.gen(function* readDeclaredVersions() {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* path.fromFileUrl(new URL("..", import.meta.url));

  const nested = yield* Effect.forEach(["apps", "packages"], (group) =>
    fs
      .readDirectory(path.join(root, group))
      .pipe(Effect.map((names) => names.map((name) => path.join(group, name)))),
  );

  const empty: typeof Manifest.Type = {};

  const manifests = yield* Effect.forEach([".", "infra", ...nested.flat()], (dir) => {
    const file = path.join(root, dir, "package.json");

    return fs
      .exists(file)
      .pipe(
        Effect.flatMap((present) =>
          present
            ? fs
                .readFileString(file)
                .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest))))
            : Effect.succeed(empty),
        ),
      );
  });

  return manifests.flatMap((manifest) =>
    [manifest.dependencies ?? {}, manifest.devDependencies ?? {}].flatMap((deps) =>
      LOCKSTEP.flatMap((name) => {
        const range = deps[name];

        return range === undefined ? [] : [{ name, range }];
      }),
    ),
  );
}).pipe(Effect.provide(BunServices.layer));

describe("the Alchemy package set", () => {
  it.effect("pins domain, alchemy and cloudflare to one exact version", () =>
    Effect.gen(function* sameVersion() {
      const declared = yield* declaredVersions;
      const names = [...new Set(declared.map((entry) => entry.name))];
      const ranges = [...new Set(declared.map((entry) => entry.range))];

      assert.sameMembers(names, [...LOCKSTEP]);
      assert.strictEqual(ranges.length, 1, `expected one version, got ${ranges.join(", ")}`);
      // An exact version: digits and an optional prerelease, never a `^` or `~` range.
      assert.match(ranges[0] ?? "", /^\d+\.\d+\.\d+(?<prerelease>-[\w.]+)?$/u);
    }),
  );
});
