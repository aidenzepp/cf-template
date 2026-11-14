import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Sink, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { deployOrDestroy } from "./global-setup.ts";

/**
 * A spawner that records each command's arguments and exits with the code `codeOf` gives it,
 * without starting a process.
 */
const stubSpawner = (seen: Array<ReadonlyArray<string>>, codeOf: (phase: string) => number) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        const args = (ChildProcess.isStandardCommand(command) ? command.args : []).map(String);

        seen.push(args);

        return ChildProcessSpawner.makeHandle({
          all: Stream.empty,
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(codeOf(args[2] ?? ""))),
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          pid: ChildProcessSpawner.ProcessId(1),
          stderr: Stream.empty,
          stdin: Sink.drain,
          stdout: Stream.empty,
          unref: Effect.succeed(Effect.void),
        });
      }),
    ),
  );

/**
 * The arguments global-setup passes to `bun` for one phase on `test-ci`.
 */
const command = (phase: "deploy" | "destroy") => [
  "run",
  "alchemy",
  phase,
  "infra/alchemy.run.ts",
  "--stage",
  "test-ci",
  "--yes",
];

const deploy = command("deploy");

const destroy = command("destroy");

describe("the cloud setup deploy", () => {
  it.effect("deploys and destroys nothing when the deploy succeeds", () =>
    Effect.gen(function* succeeded() {
      const seen: Array<ReadonlyArray<string>> = [];

      yield* deployOrDestroy("test-ci").pipe(Effect.provide(stubSpawner(seen, () => 0)));

      assert.deepStrictEqual(seen, [deploy]);
    }),
  );

  it.effect("destroys the stage when the deploy fails, and returns the deploy's error", () =>
    Effect.gen(function* failed() {
      const seen: Array<ReadonlyArray<string>> = [];

      const error = yield* Effect.flip(
        deployOrDestroy("test-ci").pipe(
          Effect.provide(stubSpawner(seen, (phase) => (phase === "deploy" ? 1 : 0))),
        ),
      );

      assert.deepStrictEqual(seen, [deploy, destroy]);
      assert.include(error.message, "alchemy deploy --stage test-ci exited with code 1");
    }),
  );

  it.effect("returns the deploy's error when the cleanup destroy fails too", () =>
    Effect.gen(function* bothFailed() {
      const seen: Array<ReadonlyArray<string>> = [];

      const error = yield* Effect.flip(
        deployOrDestroy("test-ci").pipe(Effect.provide(stubSpawner(seen, () => 1))),
      );

      assert.deepStrictEqual(seen, [deploy, destroy]);
      assert.include(error.message, "alchemy deploy");
    }),
  );
});
