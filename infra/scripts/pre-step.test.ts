import { assert, describe, it } from "@effect/vitest";
import { ConfigProvider, Effect, FileSystem, Layer, Option, Path, Sink, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { BunServices } from "@effect/platform-bun";
import {
  AccountCounts,
  PreStepError,
  enforceCap,
  parseStateList,
  planSweep,
  previewCap,
  program,
} from "./pre-step.ts";

/**
 * Read a recorded (inferred) listing: its `exit:` line and the output below it.
 */
const fixture = (name: string) =>
  Effect.gen(function* read() {
    const fs = yield* FileSystem.FileSystem;

    const text = yield* fs.readFileString(
      new URL(`fixtures/state-list/${name}.txt`, import.meta.url).pathname,
    );

    const lines = text.split("\n");
    const code = Number(/^exit: (?<code>\d+)$/u.exec(lines[1] ?? "")?.groups?.code);

    return { code, output: lines.slice(2).join("\n") };
  }).pipe(Effect.provide(BunServices.layer));

/**
 * Read and classify a recorded listing.
 */
const read = (name: string) =>
  fixture(name).pipe(Effect.map((f) => parseStateList(f.code, f.output)));

describe("parseStateList", () => {
  it.effect("reads the four states", () =>
    Effect.gen(function* states() {
      assert.strictEqual((yield* read("missing"))._tag, "Missing");
      assert.strictEqual((yield* read("outdated"))._tag, "Outdated");
      assert.strictEqual((yield* read("empty"))._tag, "Empty");
      assert.deepStrictEqual(yield* read("populated"), {
        _tag: "Populated",
        stages: ["prod", "staging-12", "staging-7", "test-ci", "test-i38"],
      });
    }),
  );
});

describe("previewCap", () => {
  it("is the limit when capacity is ample", () => {
    assert.strictEqual(
      previewCap({ limit: 10, liveOtherD1: 0, liveOtherWorkers: 0, plan: "paid" }),
      10,
    );
  });

  it("binds on Workers at 3 per stage", () => {
    assert.strictEqual(
      previewCap({ limit: 10, liveOtherD1: 0, liveOtherWorkers: 480, plan: "paid" }),
      6,
    );
  });

  it("lets a CAP override replace capacity", () => {
    assert.strictEqual(
      previewCap({ capWorkers: 2, limit: 10, liveOtherD1: 0, liveOtherWorkers: 0, plan: "paid" }),
      2,
    );
  });
});

describe("planSweep", () => {
  it("destroys closed previews only and leaves test stages and unknown PRs", () => {
    const state = new Map([
      ["staging-1", "CLOSED"],
      ["staging-2", "OPEN"],
      ["staging-4", "MERGED"],
    ]);

    const result = planSweep(
      ["prod", "staging-1", "staging-2", "staging-3", "staging-4", "test-i38"],
      (stage) => Option.fromNullishOr(state.get(stage)),
    );

    assert.deepStrictEqual(result.destroy, ["staging-1", "staging-4"]);
    assert.deepStrictEqual(result.leftover, ["prod", "staging-2", "staging-3", "test-i38"]);
  });
});

/**
 * Run the cap check with a fake account holding `workers` other Workers.
 */
const cap = (config: Record<string, string>, workers: number, count: number) =>
  enforceCap("example", count, false).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(
          AccountCounts,
          AccountCounts.of({ read: () => Effect.succeed({ d1: 0, workers }) }),
        ),
        ConfigProvider.layer(ConfigProvider.fromUnknown(config)),
      ),
    ),
  );

describe("enforceCap", () => {
  it.effect("fails when live counts push the total over the limit", () =>
    Effect.gen(function* over() {
      const error = yield* Effect.flip(cap({}, 485, 5));

      assert.instanceOf(error, PreStepError);
      assert.include(error.message, "cap is 5");
    }),
  );

  it.effect("passes under the cap and honors a CAP_WORKERS override", () =>
    Effect.gen(function* under() {
      yield* cap({}, 0, 9);

      const error = yield* Effect.flip(cap({ CAP_WORKERS: "1" }, 0, 1));

      assert.include(error.message, "cap is 1");
    }),
  );
});

/**
 * One command the stubbed spawner saw: the program, its arguments and its working directory.
 */
interface Spawned {
  readonly program: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string | undefined;
}

/**
 * What a stubbed command exits with and prints.
 */
interface Reply {
  readonly code: number;
  readonly output: string;
}

/**
 * A spawner that records every command and answers it from `reply` without starting a process.
 */
const stubSpawner = (
  seen: Array<Spawned>,
  reply: (program: string, args: ReadonlyArray<string>) => Reply,
) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        const standard = ChildProcess.isStandardCommand(command) ? command : undefined;
        const executable = standard?.command ?? "";
        const args = (standard?.args ?? []).map(String);
        seen.push({ args, cwd: standard?.options.cwd, program: executable });

        const { code, output } = reply(executable, args);

        return ChildProcessSpawner.makeHandle({
          all: Stream.make(new TextEncoder().encode(output)),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(code)),
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          pid: ChildProcessSpawner.ProcessId(1),
          stderr: Stream.empty,
          stdin: Sink.drain,
          stdout: Stream.make(new TextEncoder().encode(output)),
          unref: Effect.succeed(Effect.void),
        });
      }),
    ),
  );

/**
 * The repository root, as the pre-step resolves it from its own location.
 */
const root = Path.Path.pipe(
  Effect.flatMap((path) => path.fromFileUrl(new URL("../..", import.meta.url))),
  Effect.provide(Path.layer),
);

/**
 * Run the pre-step against stubbed commands, a fake account and the given event.
 */
const runPreStep = (
  config: Record<string, string>,
  reply: (program: string, args: ReadonlyArray<string>) => Reply,
) => {
  const seen: Array<Spawned> = [];

  return program.pipe(
    Effect.provide(
      Layer.mergeAll(
        stubSpawner(seen, reply),
        Path.layer,
        Layer.succeed(
          AccountCounts,
          AccountCounts.of({ read: () => Effect.succeed({ d1: 0, workers: 0 }) }),
        ),
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({ PR_NUMBER: "7", STACK_NAME: "example", ...config }),
        ),
      ),
    ),
    Effect.result,
    Effect.map((result) => ({ result, seen })),
  );
};

/**
 * A listing holding this PR's stage and a closed PR's stage, `gh` reporting `staging-3` closed.
 */
const listed =
  (destroyCode: number) =>
  (command: string, args: ReadonlyArray<string>): Reply => {
    if (command === "gh") {
      return { code: 0, output: "CLOSED\n" };
    }

    return args[0] === "destroy"
      ? { code: destroyCode, output: "" }
      : { code: 0, output: "prod\nstaging-3\nstaging-7\n" };
  };

describe("program", () => {
  it.effect("destroys from the repository root with the entry file and --yes", () =>
    Effect.gen(function* destroysFromRoot() {
      const { result, seen } = yield* runPreStep({ PR_ACTION: "closed" }, listed(0));
      const destroys = seen.filter((spawned) => spawned.args[0] === "destroy");

      assert.isTrue(result._tag === "Success");
      assert.deepStrictEqual(
        destroys.map((spawned) => spawned.args),
        [
          ["destroy", "infra/alchemy.run.ts", "--stage", "staging-7", "--yes"],
          ["destroy", "infra/alchemy.run.ts", "--stage", "staging-3", "--yes"],
        ],
      );

      const expected = yield* root;

      for (const spawned of destroys) {
        assert.strictEqual(spawned.program, "alchemy");
        assert.strictEqual(spawned.cwd, expected);
      }
    }),
  );

  it.effect("fails a sweep destroy that exits 1 with the stage and the command to clear it", () =>
    Effect.gen(function* stuck() {
      const { result } = yield* runPreStep({}, listed(1));

      assert.isTrue(result._tag === "Failure");

      const error = result._tag === "Failure" ? result.failure : undefined;
      assert.instanceOf(error, PreStepError);
      assert.include(error?.message, "staging-3");
      assert.include(error?.message, "exit code 1");
      assert.include(
        error?.message,
        "bun run alchemy destroy infra/alchemy.run.ts --stage staging-3 --yes",
      );
    }),
  );

  it.effect("fails this PR's own destroy on closed with the same message shape", () =>
    Effect.gen(function* ownStuck() {
      const { result } = yield* runPreStep({ PR_ACTION: "closed" }, listed(1));
      const error = result._tag === "Failure" ? result.failure : undefined;

      assert.include(
        error?.message,
        "bun run alchemy destroy infra/alchemy.run.ts --stage staging-7 --yes",
      );
    }),
  );

  it.effect("names the deploy command when the store is outdated", () =>
    Effect.gen(function* outdated() {
      const { result } = yield* runPreStep({}, () => ({
        code: 1,
        output: "state store is outdated; run upgrade",
      }));

      const error = result._tag === "Failure" ? result.failure : undefined;

      assert.include(error?.message, "alchemy deploy infra/alchemy.run.ts --stage staging-7 --yes");
    }),
  );
});
