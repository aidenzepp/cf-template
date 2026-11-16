import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Logger, Ref, Sink, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { TestClock } from "effect/testing";
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
 * The exit codes for the deploys in order: the nth `deploy` the stub spawner sees exits with
 * `codes[n - 1]`. A deploy past the list and every other phase exit 0.
 */
const deployCodes =
  (seen: Array<ReadonlyArray<string>>, codes: ReadonlyArray<number>) => (phase: string) =>
    phase === "deploy" ? (codes[seen.filter((args) => args[2] === "deploy").length - 1] ?? 0) : 0;

/**
 * Run `program` on the test clock and advance it through both retry pauses, so a deploy that keeps
 * failing reaches its last attempt without waiting.
 */
const throughPauses = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  Effect.gen(function* advanced() {
    const fiber = yield* Effect.forkChild(program);

    yield* TestClock.adjust("40 seconds");

    return yield* Fiber.join(fiber);
  });

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
  it.effect("deploys once, and destroys and retries nothing, when the deploy succeeds", () =>
    Effect.gen(function* succeeded() {
      const seen: Array<ReadonlyArray<string>> = [];
      const readied = yield* Ref.make(0);

      yield* deployOrDestroy(
        "test-ci",
        Ref.update(readied, (count) => count + 1),
      ).pipe(Effect.provide(stubSpawner(seen, () => 0)));

      assert.deepStrictEqual(seen, [deploy]);
      assert.strictEqual(yield* Ref.get(readied), 1);
    }),
  );

  it.effect("deploys again after 20 seconds when the deploy exits non-zero", () =>
    Effect.gen(function* retried() {
      const seen: Array<ReadonlyArray<string>> = [];

      const fiber = yield* Effect.forkChild(
        deployOrDestroy("test-ci", Effect.void).pipe(
          Effect.provide(stubSpawner(seen, deployCodes(seen, [1, 0]))),
        ),
      );

      yield* TestClock.adjust("19 seconds");

      assert.deepStrictEqual(seen, [deploy]);

      yield* TestClock.adjust("1 second");
      yield* Fiber.join(fiber);

      assert.deepStrictEqual(seen, [deploy, deploy]);
    }),
  );

  it.effect("runs ready and does not destroy when a retried deploy succeeds", () =>
    Effect.gen(function* recovered() {
      const seen: Array<ReadonlyArray<string>> = [];
      const readied = yield* Ref.make(0);

      yield* throughPauses(
        deployOrDestroy(
          "test-ci",
          Ref.update(readied, (count) => count + 1),
        ).pipe(Effect.provide(stubSpawner(seen, deployCodes(seen, [1, 1, 0])))),
      );

      assert.deepStrictEqual(seen, [deploy, deploy, deploy]);
      assert.strictEqual(yield* Ref.get(readied), 1);
    }),
  );

  it.effect(
    "destroys the stage once and returns the last deploy's error after three failed deploys",
    () =>
      Effect.gen(function* failed() {
        const seen: Array<ReadonlyArray<string>> = [];
        const readied = yield* Ref.make(0);

        const error = yield* Effect.flip(
          throughPauses(
            deployOrDestroy(
              "test-ci",
              Ref.update(readied, (count) => count + 1),
            ).pipe(Effect.provide(stubSpawner(seen, deployCodes(seen, [1, 2, 3])))),
          ),
        );

        assert.deepStrictEqual(seen, [deploy, deploy, deploy, destroy]);
        assert.include(error.message, "alchemy deploy --stage test-ci exited with code 3");
        assert.strictEqual(yield* Ref.get(readied), 0);
      }),
  );

  it.effect("logs one line per retry naming the attempt and the exit code", () =>
    Effect.gen(function* logged() {
      const seen: Array<ReadonlyArray<string>> = [];
      const lines: Array<string> = [];

      const collector = Logger.make((options) => {
        lines.push(String(options.message));
      });

      yield* Effect.flip(
        throughPauses(
          deployOrDestroy("test-ci", Effect.void).pipe(
            Effect.provide(
              Layer.mergeAll(
                stubSpawner(seen, deployCodes(seen, [1, 2, 3])),
                Logger.layer([collector]),
              ),
            ),
          ),
        ),
      );

      assert.deepStrictEqual(lines, [
        "Deploy attempt 1 of 3 for test-ci exited with code 1; deploying again in 20 seconds.",
        "Deploy attempt 2 of 3 for test-ci exited with code 2; deploying again in 20 seconds.",
      ]);
    }),
  );

  it.effect("destroys the stage when it deploys but never becomes ready, without a retry", () =>
    Effect.gen(function* notReady() {
      const seen: Array<ReadonlyArray<string>> = [];

      const error = yield* Effect.flip(
        deployOrDestroy("test-ci", Effect.fail({ message: "GET /auth/ok answered 404" })).pipe(
          Effect.provide(stubSpawner(seen, () => 0)),
        ),
      );

      assert.deepStrictEqual(seen, [deploy, destroy]);
      assert.strictEqual(error.message, "GET /auth/ok answered 404");
    }),
  );

  it.effect("returns the deploy's error when the cleanup destroy fails too", () =>
    Effect.gen(function* bothFailed() {
      const seen: Array<ReadonlyArray<string>> = [];

      const error = yield* Effect.flip(
        throughPauses(
          deployOrDestroy("test-ci", Effect.void).pipe(Effect.provide(stubSpawner(seen, () => 1))),
        ),
      );

      assert.deepStrictEqual(seen, [deploy, deploy, deploy, destroy]);
      assert.include(error.message, "alchemy deploy");
    }),
  );
});
