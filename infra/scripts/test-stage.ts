import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Effect, Schema, Stdio } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { decideTestStage } from "../src/test-stage.ts";

/**
 * The failure of the alchemy child process: it ran and exited non-zero.
 */
class AlchemyExited extends Schema.TaggedError<AlchemyExited>()("AlchemyExited", {
  code: Schema.Number,
}) {}

/**
 * Run `bun run alchemy <phase> infra/alchemy.run.ts --stage <stage> --yes` for a throwaway
 * `test-<slug>` stage, after the guard has proved the stage is on local state. Any other stage or
 * phase fails before alchemy is called.
 *
 * Usage: `bun infra/scripts/test-stage.ts <deploy|destroy> <stage>`.
 */
const program = Effect.gen(function* runTestStage() {
  const [phase = "", stage = ""] = yield* (yield* Stdio.Stdio).args;

  const decision = yield* decideTestStage(phase, stage).pipe(
    Effect.tapError((failure) => Console.error(failure.message)),
  );

  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const code = yield* spawner.exitCode(
    ChildProcess.make(
      "bun",
      [
        "run",
        "alchemy",
        decision.phase,
        "infra/alchemy.run.ts",
        "--stage",
        decision.stage,
        "--yes",
      ],
      { stderr: "inherit", stdin: "inherit", stdout: "inherit" },
    ),
  );

  return code === 0 ? code : yield* new AlchemyExited({ code });
});

BunRuntime.runMain(program.pipe(Effect.provide(BunServices.layer)), {
  disableErrorReporting: true,
});
