import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Config, Console, Effect, Option, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { isExempt, mergeNote, needsNote, parseLinks } from "./rules.ts";

/**
 * A `gh` call failed in a way the job does not skip: the message names the call, the exit code and
 * the last line `gh` printed.
 */
export class MergeNoteError extends Schema.TaggedError<
  MergeNoteError,
  { readonly brand: unique symbol }
>()("MergeNoteError", {
  message: Schema.String,
}) {}

/**
 * The HTTP statuses the job skips with a warning: the issue is not there (404) or GitHub refuses
 * the comment as unprocessable (422). Any other status fails the job.
 */
const skippableStatus = /\(HTTP (?:404|422)\)/u;

/**
 * Prints a GitHub Actions warning annotation on one line.
 */
const warn = (message: string) => Console.log(`::warning::${message.replaceAll(/\s+/gu, " ")}`);

/**
 * Runs `gh` with array arguments, no shell, and returns its exit code and output. `GH_TOKEN` and
 * `GH_REPO` reach it through the inherited environment.
 */
const run = Effect.fn("mergeNote.run")(function* run(args: ReadonlyArray<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  return yield* Effect.scoped(
    Effect.gen(function* spawned() {
      const handle = yield* spawner.spawn(ChildProcess.make("gh", [...args]));

      const { stderr, stdout } = yield* Effect.all(
        {
          stderr: Stream.mkString(Stream.decodeText(handle.stderr)),
          stdout: Stream.mkString(Stream.decodeText(handle.stdout)),
        },
        { concurrency: "unbounded" },
      );

      return { code: Number(yield* handle.exitCode), stderr, stdout };
    }),
  ).pipe(
    Effect.mapError((cause) => new MergeNoteError({ message: `gh did not run: ${cause.message}` })),
  );
});

/**
 * One `gh api` call. Returns its output, or nothing after a warning when GitHub answers 404 or
 * 422; any other failure is a {@link MergeNoteError}.
 */
const call = Effect.fn("mergeNote.call")(function* call(what: string, args: ReadonlyArray<string>) {
  const { code, stderr, stdout } = yield* run(["api", ...args]);

  if (code === 0) {
    return Option.some(stdout);
  }

  const line = stderr.trim().split(/\r?\n/u).at(-1) ?? "";

  if (skippableStatus.test(stderr)) {
    yield* warn(`Skipped: could not ${what}: ${line}`);

    return Option.none<string>();
  }

  return yield* new MergeNoteError({
    message: `Could not ${what}: gh api exited ${code}: ${line}`,
  });
});

/**
 * Posts the note on one issue, unless the target is a pull request, the issue already carries the
 * note, or GitHub refuses a call with 404 or 422. Returns whether it posted.
 */
const noteIssue = Effect.fn("mergeNote.noteIssue")(function* noteIssue(
  issue: number,
  note: { readonly body: string; readonly marker: string },
) {
  const path = `repos/{owner}/{repo}/issues/${issue}`;
  const kind = yield* call(`read #${issue}`, [path, "--jq", 'has("pull_request")']);

  if (Option.isNone(kind)) {
    return false;
  }

  if (kind.value.trim() === "true") {
    yield* Console.log(`#${issue} is a pull request; no note.`);

    return false;
  }

  const comments = yield* call(`list the comments of #${issue}`, [
    "--paginate",
    `${path}/comments`,
    "--jq",
    ".[].body",
  ]);

  if (Option.isNone(comments)) {
    return false;
  }

  if (!needsNote(comments.value.split(/\r?\n/u), note.marker)) {
    yield* Console.log(`#${issue} already has the note.`);

    return false;
  }

  const posted = yield* call(`comment on #${issue}`, [
    "--method",
    "POST",
    `${path}/comments`,
    "-f",
    `body=${note.body}`,
  ]);

  if (Option.isNone(posted)) {
    return false;
  }

  yield* Console.log(`Noted #${issue}.`);

  return true;
});

/**
 * Comments `#<number> merged: <title>.` once on each issue a merged pull request links under `Part
 * of` or `Refs`. GitHub records a `Closes` itself, so that issue gets nothing, and a pull request
 * that `isExempt` names (Release Please or Renovate) is skipped. The comment starts with a hidden
 * marker, and an issue that already has it is left alone, so a re-run posts nothing. The pull
 * request fields come from the environment (`PR_BODY`, `PR_TITLE`, `PR_NUMBER`, `PR_BRANCH`,
 * `PR_AUTHOR_TYPE`, `PR_AUTHOR_LOGIN`).
 *
 * @returns The issues it commented on, in order.
 */
export const program = Effect.gen(function* mergeNoteProgram() {
  const body = yield* Config.String("PR_BODY").pipe(Config.withDefault(""));
  const title = yield* Config.String("PR_TITLE");
  const number = yield* Config.Int("PR_NUMBER");
  const branch = yield* Config.String("PR_BRANCH");
  const authorType = yield* Config.String("PR_AUTHOR_TYPE");
  const authorLogin = yield* Config.String("PR_AUTHOR_LOGIN");

  if (isExempt({ authorLogin, authorType, branch, title })) {
    yield* Console.log("A release or Renovate pull request; no note.");

    return [];
  }

  const note = mergeNote(title, number, parseLinks(body));

  if (note.dropped > 0) {
    yield* warn(
      `The body links ${note.issues.length + note.dropped} issues; only the first ${note.issues.length} get a note.`,
    );
  }

  const posted: Array<number> = [];

  for (const issue of note.issues) {
    if (yield* noteIssue(issue, note)) {
      posted.push(issue);
    }
  }

  return posted;
});

if (import.meta.main) {
  BunRuntime.runMain(
    program.pipe(
      Effect.tapError((failure) => Console.error(`::error::${failure.message}`)),
      Effect.provide(BunServices.layer),
    ),
    { disableErrorReporting: true },
  );
}
