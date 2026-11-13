import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Config, Console, Effect, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/**
 * A pull request that touches the reviewed paths has no record line naming its head commit.
 */
export class RecordError extends Schema.TaggedError<
  RecordError,
  { readonly brand: unique symbol }
>()("RecordError", {
  message: Schema.String,
}) {}

/**
 * The record line `.agents/skills/design-review/SKILL.md` defines:
 * `design-review: <40-hex head sha> <pass|concerns|fail> <reason>`, alone on its line.
 */
export const recordLine =
  /^design-review: (?<sha>[0-9a-f]{40}) (?<verdict>pass|concerns|fail) (?<reason>\S.*)$/mu;

/**
 * Whether a changed path is one the record covers: a file under `apps/web` or `packages/ui`
 * that is not a test (`.test.ts` or `.test.tsx`).
 *
 * @param path - A repository-relative path.
 * @returns True when the path needs a record.
 */
export const isReviewed = (path: string): boolean =>
  /^(?:apps\/web|packages\/ui)\//u.test(path) && !/\.test\.tsx?$/u.test(path);

/**
 * Reduces a unified diff to what a merge of main cannot change: drops `index` lines and the
 * line numbers in hunk headers, which move when the base moves.
 *
 * @param diff - The text of `git diff -U0` over the reviewed paths.
 * @returns The diff with base-dependent lines removed.
 */
export const normalizeDiff = (diff: string): string =>
  diff
    .split("\n")
    .filter((line) => !line.startsWith("index "))
    .map((line) => (line.startsWith("@@") ? "@@" : line))
    .join("\n");

/**
 * Whether two reviewed-path diffs make the same change, so a record for one holds for the other.
 *
 * @param recorded - The diff from the merge base of the recorded commit to that commit.
 * @param current - The diff from the merge base of the head to the head.
 * @returns True when the changes match.
 */
export const sameChange = (recorded: string, current: string): boolean =>
  normalizeDiff(recorded) === normalizeDiff(current);

/**
 * Fails when the changed paths include a reviewed one and the body has no record line that holds
 * for `head`: one naming `head`, or one whose commit `equivalent` says made the same reviewed
 * change. The verdict never fails the check; only a missing or stale line does.
 *
 * @param changed - Paths the pull request changes.
 * @param body - The pull request body.
 * @param head - The pull request head commit sha.
 * @param equivalent - Whether a recorded commit made the same reviewed change as the head.
 * @returns Nothing on success.
 */
export const checkRecord = Effect.fn("designReview.checkRecord")(function* checkRecord<R>(
  changed: ReadonlyArray<string>,
  body: string,
  head: string,
  equivalent: (sha: string) => Effect.Effect<boolean, never, R>,
) {
  if (!changed.some(isReviewed)) {
    return yield* Effect.void;
  }

  const shas = body.split(/\r?\n/u).flatMap((line) => {
    const sha = recordLine.exec(line)?.groups?.sha;

    return sha === undefined ? [] : [sha];
  });

  if (shas.includes(head)) {
    return yield* Effect.void;
  }

  for (const sha of shas) {
    if (yield* equivalent(sha)) {
      return yield* Effect.void;
    }
  }

  return yield* new RecordError({
    message: `The pull request changes apps/web or packages/ui and its body has no line \`design-review: ${head} <pass|concerns|fail> <reason>\`. Run the design-review skill on this head and paste the line it prints.`,
  });
});

/**
 * Runs git and returns its stdout, or null when git exits non-zero or cannot start.
 */
const git = Effect.fn("designReview.git")(function* git(args: ReadonlyArray<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  return yield* Effect.scoped(
    Effect.gen(function* spawned() {
      const handle = yield* spawner.spawn(ChildProcess.make("git", args));
      const output = yield* Stream.mkString(Stream.decodeText(handle.stdout));
      const code = yield* handle.exitCode;

      return code === 0 ? output : null;
    }),
  ).pipe(Effect.orElseSucceed(() => null));
});

/**
 * The paths changed between the base branch and `HEAD`.
 */
const changedPaths = Effect.fn("designReview.changedPaths")(function* changedPaths(base: string) {
  const output = yield* git(["diff", "--name-only", `origin/${base}...HEAD`]);

  return (output ?? "").split("\n").filter((line) => line !== "");
});

/**
 * The reviewed-path diff from the merge base of `origin/<base>` and `commit` to `commit`, or
 * null when the commit is not in the fetched history.
 */
const reviewedDiff = Effect.fn("designReview.reviewedDiff")(function* reviewedDiff(
  base: string,
  commit: string,
) {
  const mergeBase = (yield* git(["merge-base", `origin/${base}`, commit]))?.trim() ?? "";

  if (mergeBase === "") {
    return null;
  }

  return yield* git([
    "diff",
    "-U0",
    "--no-color",
    mergeBase,
    commit,
    "--",
    "apps/web",
    "packages/ui",
    ":(exclude,glob)**/*.test.ts",
    ":(exclude,glob)**/*.test.tsx",
  ]);
});

if (import.meta.main) {
  BunRuntime.runMain(
    Effect.gen(function* main() {
      const body = yield* Config.String("PR_BODY").pipe(Config.withDefault(""));
      const head = yield* Config.String("PR_HEAD_SHA");
      const base = yield* Config.String("PR_BASE_REF");

      const current = yield* reviewedDiff(base, head);

      const equivalent = (sha: string) =>
        reviewedDiff(base, sha).pipe(
          Effect.map(
            (recorded) => recorded !== null && current !== null && sameChange(recorded, current),
          ),
        );

      yield* checkRecord(yield* changedPaths(base), body, head, equivalent);
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
