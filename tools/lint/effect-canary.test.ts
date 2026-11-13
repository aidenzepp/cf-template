import { BunServices } from "@effect/platform-bun";

import { assert, describe, it } from "@effect/vitest";

import { Effect, FileSystem, Path, Stream } from "effect";

import { ChildProcess, ChildProcessSpawner } from "effect/process";

/**
 * The five rules the `@effect/tsgo` `recommended` preset leaves off and `vite.config.ts` adds, each
 * with one fixture that fires and one that does not.
 */
const addedRules: ReadonlyArray<string> = [
  "effect-try-without-catch",
  "extends-native-error",
  "process-env",
  "process-env-in-effect",
  "unsafe-effect-type-assertion",
];

/**
 * The timeout of each case, which spawns the linter once: a few seconds alone, more than the 5 s
 * default on a loaded machine.
 */
const SPAWN_TIMEOUT_MS = 60_000;

/**
 * Resolves the fixture directory, the oxlint binary and the type-aware engine, both from the
 * installed Vite+ so the fixtures and `vp check` run one engine. Setting `OXLINT_TSGOLINT_PATH` on
 * every spawn keeps a bare `oxlint` from preferring another engine (`tsrs-lint`) from Oxlint 1.92
 * on.
 */
const toolchain = Effect.gen(function* resolve() {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* path.fromFileUrl(new URL("../..", import.meta.url));

  // In an isolated install the dependencies of Vite+ sit beside its real package directory, not
  // beside the `node_modules/vite-plus` link.
  const dependencies = path.dirname(
    yield* fs.realPath(path.join(root, "node_modules", "vite-plus")),
  );

  return {
    dir: path.join(root, "tools", "lint", "fixtures", "effect"),
    oxlint: path.join(dependencies, "oxlint", "bin", "oxlint"),
    root,
    tsgolint: path.join(dependencies, "oxlint-tsgolint", "bin", "tsgolint.js"),
  };
});

/**
 * Lints the named files of `tools/lint/fixtures/effect` with that directory's own `oxlintrc.json`
 * under `--deny-warnings` and returns the exit code with the combined output. The config has no
 * leading dot, so the `fire.ts` and `pass.ts` runner in `fixtures.test.ts` skips this directory.
 */
const lint = Effect.fnUntraced(function* lint(files: ReadonlyArray<string>) {
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const { dir, oxlint, root, tsgolint } = yield* toolchain;

  return yield* Effect.scoped(
    Effect.gen(function* spawned() {
      const handle = yield* spawner.spawn(
        ChildProcess.make(
          "node",
          [
            oxlint,
            "--deny-warnings",
            "-c",
            path.join(dir, "oxlintrc.json"),
            ...files.map((file) => path.join(dir, file)),
          ],
          {
            cwd: root,
            env: { NO_COLOR: "1", OXLINT_TSGOLINT_PATH: tsgolint },
            extendEnv: true,
          },
        ),
      );

      const [output, code] = yield* Effect.all(
        [Stream.mkString(Stream.decodeText(handle.all)), handle.exitCode],
        { concurrency: 2 },
      );

      return { code: Number(code), output };
    }),
  );
});

describe("Effect rules run inside the lint pass", () => {
  it.effect(
    "the canary's floating Effect fails with effecttsgo(floating-effect)",
    () =>
      Effect.gen(function* canary() {
        const { code, output } = yield* lint(["canary.ts"]);

        assert.strictEqual(code, 1, output);
        assert.include(output, "effecttsgo(floating-effect)");
      }).pipe(Effect.provide(BunServices.layer)),
    SPAWN_TIMEOUT_MS,
  );

  for (const rule of addedRules) {
    it.effect(
      `${rule}.fires.ts reports effecttsgo(${rule})`,
      () =>
        Effect.gen(function* fires() {
          const { code, output } = yield* lint([`${rule}.fires.ts`]);

          assert.strictEqual(code, 1, output);
          assert.include(output, `effecttsgo(${rule})`);
        }).pipe(Effect.provide(BunServices.layer)),
      SPAWN_TIMEOUT_MS,
    );

    it.effect(
      `${rule}.passes.ts reports nothing`,
      () =>
        Effect.gen(function* passes() {
          const { code, output } = yield* lint([`${rule}.passes.ts`]);

          assert.strictEqual(code, 0, output);
          assert.notInclude(output, "effecttsgo(");
        }).pipe(Effect.provide(BunServices.layer)),
      SPAWN_TIMEOUT_MS,
    );
  }

  it.effect(
    "an oxlint-disable-next-line directive suppresses an Effect finding",
    () =>
      Effect.gen(function* suppressed() {
        const { code, output } = yield* lint(["directive-suppresses.ts"]);

        assert.strictEqual(code, 0, output);
        assert.notInclude(output, "effecttsgo(");
      }).pipe(Effect.provide(BunServices.layer)),
    SPAWN_TIMEOUT_MS,
  );

  it.effect(
    "the same directive over a clean line fails as an unused directive",
    () =>
      Effect.gen(function* unused() {
        const { code, output } = yield* lint(["directive-unused.ts"]);

        assert.strictEqual(code, 1, output);
        assert.include(output, "Unused oxlint-disable directive");
      }).pipe(Effect.provide(BunServices.layer)),
    SPAWN_TIMEOUT_MS,
  );
});
