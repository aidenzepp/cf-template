import { BunRuntime } from "@effect/platform-bun";
import { Config, Console, Effect } from "effect";
import { check } from "./rules.ts";

if (import.meta.main) {
  BunRuntime.runMain(
    Effect.gen(function* main() {
      const body = yield* Config.String("PR_BODY").pipe(Config.withDefault(""));
      const branch = yield* Config.String("PR_BRANCH");
      const authorType = yield* Config.String("PR_AUTHOR_TYPE");

      yield* check({ authorType, body, branch });
    }).pipe(
      Effect.catchTag("PrBodyError", ({ message }) =>
        Console.error(message).pipe(
          Effect.andThen(
            Effect.sync(() => {
              process.exitCode = 1;
            }),
          ),
        ),
      ),
    ),
  );
}
