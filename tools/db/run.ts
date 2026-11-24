import { Config, Effect, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/**
 * Runs `command` in `cwd` with only `PATH` and `HOME` in its environment, so no inherited `GIT_*`
 * variable can aim it at another repository, and returns its stdout.
 */
export const run = Effect.fn("db.check.run")(function* run(
  cwd: string,
  command: string,
  args: ReadonlyArray<string>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const env = { HOME: yield* Config.String("HOME"), PATH: yield* Config.String("PATH") };

  return yield* Effect.scoped(
    Effect.gen(function* spawned() {
      const handle = yield* spawner.spawn(
        ChildProcess.make(command, args, { cwd, env, extendEnv: false, stderr: "ignore" }),
      );

      return yield* Stream.mkString(Stream.decodeText(handle.stdout));
    }),
  );
});

/**
 * Runs `git -C root <args>` with only `PATH` and `HOME` in its environment and returns the output
 * as lines.
 */
export const gitLines = Effect.fn("db.check.gitLines")(function* gitLines(
  root: string,
  args: ReadonlyArray<string>,
) {
  return (yield* run(root, "git", ["-C", root, ...args])).split("\n").filter((line) => line !== "");
});
