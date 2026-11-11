import { createRequire } from "node:module";
import { BunServices } from "@effect/platform-bun";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/**
 * The oxlint JSON report, reduced to the file name of each diagnostic.
 */
const Report = Schema.fromJsonString(
  Schema.Struct({ diagnostics: Schema.Array(Schema.Struct({ filename: Schema.String })) }),
);

/**
 * Resolves the repository root, the oxlint binary and the type-aware engine, both from the
 * installed Vite+ so the fixtures and `vp check` run one engine. Vite+ pins `oxlint` and
 * `oxlint-tsgolint` as its own dependencies, so they resolve only from its package location.
 * Setting `OXLINT_TSGOLINT_PATH` on every spawn keeps a bare `oxlint` from preferring another
 * engine (`tsrs-lint`) from Oxlint 1.92 on.
 */
const toolchain = Effect.gen(function* resolve() {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* path.fromFileUrl(new URL("../..", import.meta.url));

  // Resolution starts at the real package directory: the `node_modules/vite-plus` link does not
  // sit beside its dependencies in an isolated install.
  const vitePlus = yield* fs.realPath(path.join(root, "node_modules", "vite-plus", "package.json"));

  const fromVitePlus = createRequire(vitePlus);

  const tsgolint = fromVitePlus.resolve("oxlint-tsgolint/bin/tsgolint");

  const oxlint = path.join(
    path.dirname(path.dirname(fromVitePlus.resolve("oxlint"))),
    "bin",
    "oxlint",
  );

  return { oxlint, root, tsgolint };
});

/**
 * Lints the given fixture files with the fixture's own `.oxlintrc.json` and returns the number of
 * diagnostics reported per file name.
 */
const lintFixture = Effect.fnUntraced(function* lintFixture(dir: string, files: readonly string[]) {
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const { oxlint, root, tsgolint } = yield* toolchain;

  const output = yield* spawner.string(
    ChildProcess.make(
      "node",
      [
        oxlint,
        "-f",
        "json",
        "-c",
        path.join(dir, ".oxlintrc.json"),
        ...files.map((file) => path.join(dir, file)),
      ],
      { cwd: root, env: { OXLINT_TSGOLINT_PATH: tsgolint }, extendEnv: true },
    ),
  );

  const { diagnostics } = yield* Schema.decodeUnknownEffect(Report)(output);

  return (file: string) =>
    diagnostics.filter((diagnostic) => path.basename(diagnostic.filename) === file).length;
});

describe("lint fixtures", () => {
  it.effect("the type-aware engine Vite+ uses exists", () =>
    Effect.gen(function* engine() {
      const fs = yield* FileSystem.FileSystem;
      const { oxlint, tsgolint } = yield* toolchain;

      assert.isTrue(yield* fs.exists(tsgolint));
      assert.isTrue(yield* fs.exists(oxlint));
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("each rule fixture fires once on fire.ts and never on pass.ts", () =>
    Effect.gen(function* rules() {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root } = yield* toolchain;
      const fixtures = path.join(root, "tools", "lint", "fixtures");

      for (const name of yield* fs.readDirectory(fixtures)) {
        const dir = path.join(fixtures, name);

        if (yield* fs.exists(path.join(dir, ".oxlintrc.json"))) {
          const count = yield* lintFixture(dir, ["fire.ts", "pass.ts"]);

          assert.strictEqual(count("fire.ts"), 1, `${name}/fire.ts`);
          assert.strictEqual(count("pass.ts"), 0, `${name}/pass.ts`);
        }
      }
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("a package import that leaves rootDir fails the installed tsc with TS6059", () =>
    Effect.gen(function* escape() {
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const { root } = yield* toolchain;

      // `typescript` 7.0.2 installs the native compiler behind `node_modules/.bin/tsc`.
      const output = yield* spawner.string(
        ChildProcess.make(
          path.join(root, "node_modules", ".bin", "tsc"),
          ["-p", "tools/lint/fixtures/package-escape/tsconfig.json"],
          { cwd: root },
        ),
      );

      assert.include(output, "error TS6059");
    }).pipe(Effect.provide(BunServices.layer)),
  );
});
