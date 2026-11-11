import { BunRuntime } from "@effect/platform-bun";
import { Console, Effect } from "effect";
import { resolveStackName } from "../src/stack-name.ts";

/**
 * Print the derived stack name to stdout, or the failure message to stderr with exit code 1.
 */
const program = Effect.gen(function* printStackName() {
  const name = yield* resolveStackName().pipe(
    Effect.tapError((failure) => Console.error(failure.message)),
  );

  yield* Console.log(name);
});

BunRuntime.runMain(program, { disableErrorReporting: true });
