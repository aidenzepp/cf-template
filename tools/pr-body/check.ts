import { BunRuntime } from "@effect/platform-bun";
import { Config, Console, Effect } from "effect";
import { check } from "./rules.ts";

if (import.meta.main) {
  BunRuntime.runMain(
    Effect.gen(function* main() {
      const body = yield* Config.String("PR_BODY").pipe(Config.withDefault(""));
      const branch = yield* Config.String("PR_BRANCH");
      const authorType = yield* Config.String("PR_AUTHOR_TYPE");
      const authorLogin = yield* Config.String("PR_AUTHOR_LOGIN");
      const title = yield* Config.String("PR_TITLE");

      yield* check({ authorLogin, authorType, body, branch, title });
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
