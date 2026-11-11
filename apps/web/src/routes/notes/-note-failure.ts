import { Cause, Option } from "effect";
import { AsyncResult } from "effect/reactivity";

/**
 * What a failed note call means for the page, told apart by the error's declared `_tag`.
 */
export type NoteFailure = "missing" | "other" | "unavailable";

/**
 * Classify the failure of a note call.
 *
 * `NotesUnavailable` and `NoteNotFound` are both 404 Problems, so only the tag tells them apart.
 *
 * @param result - The value of a query or mutation atom.
 * @returns The kind of failure, or `undefined` when the call has not failed.
 */
export const noteFailureOf = (
  result: AsyncResult.AsyncResult<unknown, { readonly _tag: string }>,
): NoteFailure | undefined => {
  if (!AsyncResult.isFailure(result)) {
    return undefined;
  }

  const error = Cause.findErrorOption(result.cause);

  if (Option.isNone(error)) {
    return "other";
  }

  if (error.value._tag === "NoteNotFound") {
    return "missing";
  }

  return error.value._tag === "NotesUnavailable" ? "unavailable" : "other";
};
