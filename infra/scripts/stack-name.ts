import { Console, Effect } from "effect";
import { resolveStackName } from "../src/stack-name.ts";

/**
 * Print the derived stack name to stdout, or the failure message to stderr with exit code 1.
 */
const program = resolveStackName().pipe(
  Effect.matchEffect({
    onFailure: (error) =>
      Console.error(error.message).pipe(
        Effect.andThen(
          Effect.sync(() => {
            process.exitCode = 1;
          }),
        ),
      ),
    onSuccess: (name) => Console.log(name),
  }),
);

await Effect.runPromise(program);
