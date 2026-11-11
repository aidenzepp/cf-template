import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Config, Effect } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/**
 * The advisories `bun audit` does not fail on, each as one `--ignore <GHSA id>` argument with a
 * `//` comment beside the flag naming the reason. The same reason goes in the body of the commit
 * that adds it. None exists at landing.
 */
const suppressions: ReadonlyArray<string> = [];

/**
 * The `bun audit` arguments: the moderate threshold and one `--ignore <GHSA id>` per suppression.
 */
export const auditArguments = (ignored: ReadonlyArray<string>): ReadonlyArray<string> => [
  "audit",
  "--audit-level=moderate",
  ...ignored.flatMap((id) => ["--ignore", id]),
];

/**
 * Runs `bun audit --audit-level=moderate`, streams its output, and returns its exit code. The
 * child sees only `PATH` and `HOME`, so no inherited variable changes what it scans.
 */
export const audit = Effect.fn("advisories.audit")(function* audit() {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const env = { HOME: yield* Config.String("HOME"), PATH: yield* Config.String("PATH") };

  return yield* Effect.scoped(
    Effect.gen(function* spawned() {
      const handle = yield* spawner.spawn(
        ChildProcess.make("bun", auditArguments(suppressions), {
          env,
          extendEnv: false,
          stderr: "inherit",
          stdout: "inherit",
        }),
      );

      return yield* handle.exitCode;
    }),
  );
});

if (import.meta.main) {
  BunRuntime.runMain(
    audit().pipe(
      Effect.flatMap((code) =>
        Effect.sync(() => {
          process.exitCode = code;
        }),
      ),
      Effect.provide(BunServices.layer),
    ),
  );
}
