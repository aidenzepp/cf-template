import { BunServices } from "@effect/platform-bun";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Stream, Config } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { DesignMdLintError, checkFindings } from "./lint.ts";

/**
 * Runs the pinned linter under Bun on a fixture, as the `check` script does, and checks its JSON.
 */
const lintFixture = Effect.fn("lintFixture")(function* lintFixture(name: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const file = `${import.meta.dirname}/fixtures/lint-${name}.DESIGN.md`;
  const env = { HOME: yield* Config.String("HOME"), PATH: yield* Config.String("PATH") };

  const output = yield* Effect.scoped(
    Effect.gen(function* spawned() {
      const handle = yield* spawner.spawn(
        ChildProcess.make(
          "bun",
          ["--bun", "node_modules/.bin/design.md", "lint", "--format", "json", file],
          {
            env,
            extendEnv: false,
          },
        ),
      );

      return yield* Stream.mkString(Stream.decodeText(handle.stdout));
    }),
  );

  yield* checkFindings(file, output);
});

describe("design-md lint", () => {
  it.effect("passes a file with only info findings", () =>
    lintFixture("info").pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("fails a broken reference on the error", () =>
    Effect.gen(function* test() {
      const error = yield* Effect.flip(lintFixture("broken-ref"));

      assert.instanceOf(error, DesignMdLintError);
      assert.include(error.message, "error broken-ref");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("fails a file with a warning finding", () =>
    Effect.gen(function* test() {
      const error = yield* Effect.flip(lintFixture("warning"));

      assert.include(error.message, "warning missing-typography");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("fails output that is not the documented JSON", () =>
    Effect.gen(function* test() {
      const error = yield* Effect.flip(checkFindings("x", "not json"));

      assert.include(error.message, "did not print the JSON");
    }),
  );
});
