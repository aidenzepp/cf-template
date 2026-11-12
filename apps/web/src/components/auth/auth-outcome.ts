import { Effect } from "effect";
import { authErrorCopy } from "../../lib/auth-error-copy.ts";
import { needsFreshSession, settle } from "../../lib/settings-calls.ts";
import type { Settled } from "../../lib/settings-calls.ts";
import { failed, paused, saved } from "../form/submit-form.ts";
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

/**
 * Makes one settings call and says how it went. A call the server refuses for a stale session is
 * `paused`: the screen asks for the password, then runs the call again.
 *
 * @param call - The client call.
 * @param title - The success toast's title, or none for a call that leaves the page.
 * @param after - Runs once the call settled for any reason but a stale session, to reload a list.
 * @returns The outcome.
 */
export const settingsOutcome = (
  call: (signal: AbortSignal) => PromiseLike<Settled>,
  title: string | undefined,
  after?: () => void,
): Effect.Effect<Outcome> =>
  Effect.gen(function* attempt() {
    const { error } = yield* settle(call);

    if (needsFreshSession(error)) {
      return paused;
    }

    yield* Effect.sync(() => after?.());

    return error === null ? saved(title) : failed(authErrorCopy({ aborted: false, error }));
  });
