import { Cause, Effect, Exit, Option } from "effect";
import { failed, saved } from "../../components/form/submit-form.ts";
import type { Outcome } from "../../components/form/submit-form.ts";

/**
 * A failed save call's error as far as the line reads it.
 */
export interface SaveError {
  readonly _tag: string;
  readonly limit?: number;
}

/**
 * The line shown for a failed save call.
 *
 * @param cause - The cause of the failed call.
 * @returns The line.
 */
export const failureLine = (cause: Cause.Cause<SaveError>) => {
  const error = Cause.findErrorOption(cause);

  return Option.isSome(error) && error.value._tag === "NoteQuotaExceeded"
    ? `You have reached the limit of ${error.value.limit} notes.`
    : "The note could not be saved.";
};

/**
 * Makes one save call and says how it went.
 *
 * @param save - The atom call, which settles with the call's exit.
 * @param title - The success toast's title.
 * @param after - Runs after a success, to re-read what the call changed.
 * @returns The outcome.
 */
export const saveNote = (
  save: () => Promise<Exit.Exit<unknown, SaveError>>,
  title: string,
  after: () => void,
): Effect.Effect<Outcome> =>
  Effect.gen(function* attempt() {
    const exit = yield* Effect.promise(save);

    if (Exit.isFailure(exit)) {
      return failed(failureLine(exit.cause));
    }

    yield* Effect.sync(after);

    return saved(title);
  });
