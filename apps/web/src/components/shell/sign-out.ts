import { Effect } from "effect";

/**
 * How a sign-out call ended: the session is gone, or it is still there.
 */
export type SignOutOutcome = "failed" | "signedOut";

/**
 * The toast shown when sign-out fails. It names what failed, says the session is still active and
 * gives the one next step; a failed call can be a dropped connection as well as a refusal, and a
 * second try is the fix for both.
 */
export const signOutFailure = {
  description: "You are still signed in. Check your connection, then select Sign out again.",
  title: "Could not sign out",
} as const;

/**
 * Runs the auth client's sign-out call and reports how it ended. A call that rejects, and a
 * response that carries an `error`, both mean the session is still in place.
 *
 * @param call - The sign-out call of the auth client.
 * @returns The outcome; the effect never fails.
 */
export const signOutOutcome = (
  call: () => PromiseLike<{ readonly error: unknown }>,
): Effect.Effect<SignOutOutcome> =>
  Effect.tryPromise(call).pipe(
    Effect.match({
      onFailure: (): SignOutOutcome => "failed",
      onSuccess: ({ error }): SignOutOutcome => (error === null ? "signedOut" : "failed"),
    }),
  );

/**
 * The whole sign-out: the call, then either `fail` (the session is still in place) or `leave` (the
 * session is gone, so re-derive the route context and open the sign-in screen).
 *
 * @param steps - The call and the two continuations.
 * @param steps.call - The sign-out call of the auth client.
 * @param steps.fail - Shows the failure; it runs only when the call failed.
 * @param steps.leave - Re-derives the session and navigates; it runs only after a sign-out.
 * @returns The effect that runs the flow; it never fails.
 */
export const signOutFlow = (steps: {
  readonly call: () => PromiseLike<{ readonly error: unknown }>;
  readonly fail: () => void;
  readonly leave: () => PromiseLike<void>;
}): Effect.Effect<void> =>
  Effect.gen(function* flow() {
    const outcome = yield* signOutOutcome(steps.call);

    if (outcome === "failed") {
      steps.fail();

      return;
    }

    yield* Effect.promise(steps.leave);
  });
