import { Effect } from "effect";
import { authErrorCopy } from "../../lib/auth-error-copy.ts";
import { settle } from "../../lib/settings-calls.ts";
import type { Settled } from "../../lib/settings-calls.ts";
import { failed, saved } from "../form/submit-form.ts";
import type { Outcome } from "../form/submit-form.ts";

/**
 * Makes one auth client call and says how it went. A call that rejects before any response is
 * status 0; a call interrupted when the route unmounts is aborted through its signal.
 *
 * @param call - The client call, given the signal that aborts it.
 * @param onSaved - Runs after a success, to open the next screen.
 * @returns The outcome: saved, or failed with the line to show.
 */
export const authOutcome = (
  call: (signal: AbortSignal) => PromiseLike<Settled>,
  onSaved: () => void,
): Effect.Effect<Outcome> =>
  Effect.gen(function* attempt() {
    const { error } = yield* settle(call);

    if (error === null) {
      yield* Effect.sync(onSaved);

      return saved();
    }

    return failed(authErrorCopy({ aborted: false, error }));
  });
