import { Effect } from "effect";
import { decodeForm } from "./decode-form.ts";
import type { FieldErrors, FormSchema } from "./decode-form.ts";

/**
 * What a submit effect settles with. `Saved` raises a success toast when it has a title. `Failed`
 * shows `message` under the fields, or nothing when it is `null` (an aborted call). `Paused` shows
 * nothing: the call was refused for a reason the screen answers first, such as a stale session, and
 * the form's `onPaused` receives the retry.
 */
export type Outcome =
  | { readonly _tag: "Saved"; readonly title: string | undefined }
  | { readonly _tag: "Failed"; readonly message: string | null }
  | { readonly _tag: "Paused" };

/**
 * An outcome of the form itself: the decode failed, so no call was made.
 */
export interface Invalid {
  readonly _tag: "Invalid";
  readonly errors: FieldErrors;
}

/**
 * The call finished.
 *
 * @param title - The success toast's title, or none for a call that leaves the screen.
 * @returns The outcome.
 */
export const saved = (title?: string): Outcome => ({ _tag: "Saved", title });

/**
 * The call failed.
 *
 * @param message - The line to show under the fields, or `null` to show nothing.
 * @returns The outcome.
 */
export const failed = (message: string | null): Outcome => ({ _tag: "Failed", message });

/**
 * The call needs an answer from the screen before it can run again.
 */
export const paused: Outcome = { _tag: "Paused" };

/**
 * Decodes a submitted form and, when every field is valid, runs the submit effect with the decoded
 * value. An invalid form makes no call.
 *
 * @param schema - The schema of the form's fields.
 * @param submit - The call made with the decoded value; it never fails, its outcome says how it
 *   went.
 * @returns A function from the submitted data to the outcome.
 */
export const submitForm =
  <S extends FormSchema>(schema: S, submit: (values: S["Type"]) => Effect.Effect<Outcome>) =>
  (form: FormData): Effect.Effect<Outcome | Invalid> =>
    decodeForm(schema)(form).pipe(
      Effect.matchEffect({
        onFailure: (errors): Effect.Effect<Outcome | Invalid> =>
          Effect.succeed({ _tag: "Invalid", errors }),
        onSuccess: submit,
      }),
    );
