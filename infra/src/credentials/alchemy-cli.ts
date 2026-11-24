import { Effect, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { CredentialsError, failed } from "./model.ts";

/**
 * Run `bun run alchemy` with `STACK_NAME` and the extra environment, capturing stdout. It sets
 * `ALCHEMY_LOG_FORMAT=json`, which sends Alchemy's log records to stderr; the pretty format writes
 * them to stdout, ahead of the command's own output.
 *
 * @param args - The arguments after `alchemy`.
 * @param env - The extra environment.
 * @returns The exit code and stdout.
 */
export const alchemy = (args: ReadonlyArray<string>, env: Record<string, string>) =>
  Effect.scoped(
    Effect.gen(function* runAlchemy() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

      const handle = yield* spawner.spawn(
        ChildProcess.make("bun", ["run", "alchemy", ...args], {
          env: { ...env, ALCHEMY_LOG_FORMAT: "json" },
          extendEnv: true,
          stderr: "inherit",
        }),
      );

      const [stdout, exitCode] = yield* Effect.all(
        [Stream.mkString(Stream.decodeText(handle.stdout)), handle.exitCode],
        { concurrency: 2 },
      );

      return { exitCode: Number(exitCode), stdout };
    }),
  );

/**
 * Run `bun run alchemy` with the terminal attached, failing on a non-zero exit.
 *
 * @param step - The step name for the failure.
 * @param args - The arguments after `alchemy`.
 * @param env - The extra environment.
 * @returns Nothing, or the failure.
 */
export const alchemyAttached = (
  step: string,
  args: ReadonlyArray<string>,
  env: Record<string, string>,
) =>
  Effect.gen(function* runAttached() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const exitCode = yield* spawner
      .exitCode(
        ChildProcess.make("bun", ["run", "alchemy", ...args], {
          env,
          extendEnv: true,
          stderr: "inherit",
          stdin: "inherit",
          stdout: "inherit",
        }),
      )
      .pipe(Effect.mapError(failed(step)));

    return Number(exitCode) === 0
      ? undefined
      : yield* new CredentialsError({
          message: `${step} exited ${Number(exitCode)}. Fix the error above and run again; a re-run resumes.`,
        });
  });
