import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Config, Console, Effect, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/**
 * A pull request that touches the reviewed paths has no record line naming its head commit.
 */
export class RecordError extends Schema.TaggedError<RecordError>()("RecordError", {
  message: Schema.String,
}) {}

/**
 * The record line `.agents/skills/design-review/SKILL.md` defines:
 * `design-review: <40-hex head sha> <pass|concerns|fail> <reason>`, alone on its line.
 */
export const recordLine =
  /^design-review: (?<sha>[0-9a-f]{40}) (?<verdict>pass|concerns|fail) (?<reason>\S.*)$/mu;

/**
 * Whether a changed path is one the record covers: a file under `apps/web` or `packages/ui`.
 *
 * @param path - A repository-relative path.
 * @returns True when the path needs a record.
 */
export const isReviewed = (path: string): boolean => /^(?:apps\/web|packages\/ui)\//u.test(path);

/**
 * Fails when the changed paths include a reviewed one and the body has no record line for `head`.
 * The verdict never fails the check; only a missing or stale line does.
 *
 * @param changed - Paths the pull request changes.
 * @param body - The pull request body.
 * @param head - The pull request head commit sha.
 * @returns Nothing on success.
 */
export const checkRecord = Effect.fn("designReview.checkRecord")(function* checkRecord(
  changed: ReadonlyArray<string>,
  body: string,
  head: string,
) {
  if (!changed.some(isReviewed)) {
    return;
  }

  const found = body.split(/\r?\n/u).some((line) => recordLine.exec(line)?.groups?.sha === head);

  if (!found) {
    yield* new RecordError({
      message: `The pull request changes apps/web or packages/ui and its body has no line \`design-review: ${head} <pass|concerns|fail> <reason>\`. Run the design-review skill on this head and paste the line it prints.`,
    });
  }
});

/**
 * The paths changed between the base branch and `HEAD`.
 */
const changedPaths = Effect.fn("designReview.changedPaths")(function* changedPaths(base: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const output = yield* Effect.scoped(
    Effect.gen(function* spawned() {
      const handle = yield* spawner.spawn(
        ChildProcess.make("git", ["diff", "--name-only", `origin/${base}...HEAD`]),
      );

      return yield* Stream.mkString(Stream.decodeText(handle.stdout));
    }),
  );

  return output.split("\n").filter((line) => line !== "");
});

if (import.meta.main) {
  BunRuntime.runMain(
    Effect.gen(function* main() {
      const body = yield* Config.String("PR_BODY").pipe(Config.withDefault(""));
      const head = yield* Config.String("PR_HEAD_SHA");
      const base = yield* Config.String("PR_BASE_REF");

      yield* checkRecord(yield* changedPaths(base), body, head);
    }).pipe(
      Effect.catchTag("RecordError", ({ message }) =>
        Console.error(message).pipe(
          Effect.andThen(
            Effect.sync(() => {
              process.exitCode = 1;
            }),
          ),
        ),
      ),
      Effect.provide(BunServices.layer),
    ),
  );
}
