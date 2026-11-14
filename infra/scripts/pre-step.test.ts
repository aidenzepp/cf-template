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
import type { Captured } from "./pre-step.ts";

/**
 * Read a derived listing fixture: its `exit:` line, then the text under `--- stdout` and
 * `--- stderr`.
 */
const fixture = (name: string) =>
  Effect.gen(function* read() {
    const fs = yield* FileSystem.FileSystem;

    const text = yield* fs.readFileString(
      new URL(`fixtures/state-list/${name}.txt`, import.meta.url).pathname,
    );

    const code = Number(/^exit: (?<code>\d+)$/mu.exec(text)?.groups?.code);
    const [, stdout = "", stderr = ""] = text.split(/^--- (?:stdout|stderr)$/mu);

    return { code, stderr: stderr.trim(), stdout: stdout.trim() } satisfies Captured;
  }).pipe(Effect.provide(BunServices.layer));

/**
 * Classify a bare listing fixture, with an app listing fixture when the second step ran.
 */
const read = (stacks: string, stages?: string) =>
  Effect.gen(function* classify() {
    return parseStateList(
      yield* fixture(stacks),
      stages === undefined ? Option.none() : Option.some(yield* fixture(stages)),
    );
  });

describe("parseStateList", () => {
  it.effect("reads a missing or half-bootstrapped store as Missing", () =>
    Effect.gen(function* missing() {
      assert.strictEqual((yield* read("missing"))._tag, "Missing");
      assert.strictEqual((yield* read("unfinished"))._tag, "Missing");
    }),
  );

  it.effect("reads `is out of date` as Outdated beside the new-version warning", () =>
    Effect.gen(function* outdated() {
      assert.strictEqual((yield* read("outdated"))._tag, "Outdated");
    }),
  );

  it.effect("reads any other failure as Failed with the output's last line", () =>
    Effect.gen(function* failed() {
      assert.deepStrictEqual(yield* read("failed"), {
        _tag: "Failed",
        code: 1,
        line: "Cloudflare API request failed: 403 Forbidden",
      });
    }),
  );

  it.effect("reads a store with no app stack as Empty", () =>
    Effect.gen(function* empty() {
      assert.strictEqual((yield* read("stacks-no-app"))._tag, "Empty");
      assert.strictEqual((yield* read("stacks", "stages-no-app"))._tag, "Empty");
    }),
  );

  it.effect("reads the stages from the app listing past the task lines", () =>
    Effect.gen(function* populated() {
      assert.deepStrictEqual(yield* read("stacks", "stages"), {
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
 * One command the stubbed spawner saw: the program, its arguments, working directory and env.
 */
interface Spawned {
  readonly program: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string | undefined;
  readonly env: ChildProcess.CommandOptions["env"];
}

/**
 * What a stubbed command exits with and prints.
 */
type Reply = Captured;

/**
 * Encode a stubbed stream's text.
 */
const bytes = (text: string) => Stream.make(new TextEncoder().encode(text));

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
        seen.push({
          args,
          cwd: standard?.options.cwd,
          env: standard?.options.env,
          program: executable,
        });

        const { code, stderr, stdout } = reply(executable, args);

        return ChildProcessSpawner.makeHandle({
          all: Stream.concat(bytes(stdout), bytes(stderr)),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(code)),
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          pid: ChildProcessSpawner.ProcessId(1),
          stderr: bytes(stderr),
          stdin: Sink.drain,
          stdout: bytes(stdout),
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
 * The app stack's two-step listing holding this PR's stage and a closed PR's stage, `gh` reporting
 * `staging-3` closed, and task lines on stdout as the plain renderer prints them.
 */
const listed =
  (destroyCode: number) =>
  (command: string, args: ReadonlyArray<string>): Reply => {
    if (command === "gh") {
      return { code: 0, stderr: "", stdout: "CLOSED\n" };
    }

    if (args[0] === "destroy") {
      return { code: destroyCode, stderr: "", stdout: "" };
    }

    return args[2] === "app"
      ? { code: 0, stderr: "", stdout: "• Resolving\napp/prod/\napp/staging-3/\napp/staging-7/\n" }
      : { code: 0, stderr: "", stdout: "app/\nexample-bootstrap/\n" };
  };

describe("program", () => {
  it.effect("skips the app listing when the store holds no app stack", () =>
    Effect.gen(function* noApp() {
      const { result, seen } = yield* runPreStep({}, () => ({
        code: 0,
        stderr: "",
        stdout: "example-bootstrap/\n",
      }));

      assert.isTrue(result._tag === "Success");
      assert.deepStrictEqual(
        seen.map((spawned) => spawned.args),
        [["state", "list"]],
      );
    }),
  );

  it.effect("fails an unrecognized listing error quoting its last line", () =>
    Effect.gen(function* unknown() {
      const { result } = yield* runPreStep({}, () => ({
        code: 2,
        stderr: "first\nCloudflare API request failed: 403 Forbidden\n",
        stdout: "",
      }));

      const error = result._tag === "Failure" ? result.failure : undefined;

      assert.include(error?.message, "exited 2: Cloudflare API request failed: 403 Forbidden");
    }),
  );

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

      const calls = seen.filter((spawned) => spawned.program === "alchemy");

      assert.deepStrictEqual(
        calls.slice(0, 2).map((spawned) => spawned.args),
        [
          ["state", "list"],
          ["state", "list", "app"],
        ],
      );

      for (const spawned of calls) {
        assert.deepStrictEqual(spawned.env, { ALCHEMY_LOG_FORMAT: "json" });
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

  it.effect("names the bootstrap command when the store is out of date", () =>
    Effect.gen(function* outdated() {
      const { result } = yield* runPreStep({}, () => ({
        code: 1,
        stderr: "Cloudflare State Store 'example-state' is out of date (expected v3, observed v2).",
        stdout: "",
      }));

      const error = result._tag === "Failure" ? result.failure : undefined;

      assert.include(
        error?.message,
        "STACK_NAME=example bun run alchemy state bootstrap --config infra/alchemy.run.ts --profile <admin profile>",
      );
    }),
  );
});
