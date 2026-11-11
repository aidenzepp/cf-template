import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Effect, FileSystem, Option, Path, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/**
 * Runs `git` with the given arguments in the current directory and returns its exit code and
 * trimmed stdout. A non-zero exit code is a result, not a failure.
 */
const git = Effect.fn("hooks.git")(function* git(args: readonly string[]) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  return yield* Effect.scoped(
    Effect.gen(function* run() {
      const handle = yield* spawner.spawn(ChildProcess.make("git", args, { stderr: "ignore" }));

      const [output, code] = yield* Effect.all(
        [Stream.mkString(Stream.decodeText(handle.stdout)), handle.exitCode],
        { concurrency: 2 },
      );

      return { code, output: output.trim() };
    }),
  );
});

/**
 * Whether any of the owner, group or other execute bits is set: an odd digit in the three
 * permission digits of the octal mode.
 */
const hasExecuteBit = (info: FileSystem.File.Info) =>
  (info.mode % 0o1000)
    .toString(8)
    .split("")
    .some((digit) => Number(digit) % 2 === 1);

/**
 * Checks that git resolves a `pre-push` hook that exists and is executable. Returns the failure
 * message, or nothing when the hook resolves or the current directory is not a work tree.
 */
export const presenceProblem = Effect.fn("hooks.presenceProblem")(function* presenceProblem() {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const toplevel = yield* git(["rev-parse", "--show-toplevel"]);

  if (toplevel.code !== 0) {
    return Option.none();
  }

  const hooks = yield* git(["rev-parse", "--git-path", "hooks"]);
  const hook = path.resolve(hooks.output, "pre-push");

  const executable = yield* fs
    .exists(hook)
    .pipe(
      Effect.flatMap((exists) =>
        exists ? fs.stat(hook).pipe(Effect.map(hasExecuteBit)) : Effect.succeed(false),
      ),
    );

  return executable
    ? Option.none()
    : Option.some(
        `pre-push hook not resolvable in ${toplevel.output}: run bun install (sets core.hooksPath)`,
      );
});

if (import.meta.main) {
  BunRuntime.runMain(
    Effect.gen(function* main() {
      const problem = yield* presenceProblem();

      if (Option.isSome(problem)) {
        yield* Console.error(problem.value);
        yield* Effect.sync(() => {
          process.exitCode = 1;
        });
      }
    }).pipe(Effect.provide(BunServices.layer)),
  );
}
