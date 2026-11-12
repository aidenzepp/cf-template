import { Effect } from "effect";
import type { AuthErrorInput } from "../../lib/auth-error-copy.ts";
import { betterAuthCall } from "../../lib/better-auth-call.ts";

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
 * The whole sign-out: the call, then either `fail` (the session is still in place) or `leave` (the
 * session is gone, so re-derive the route context and open the sign-in screen). A call that
 * rejects, and a response that carries an `error`, both mean the session is still in place.
 *
 * @param steps - The call and the two continuations.
 * @param steps.call - The sign-out call of the auth client.
 * @param steps.fail - Shows the failure; it runs only when the call failed.
 * @param steps.leave - Re-derives the session and navigates; it runs only after a sign-out.
 * @returns The effect that runs the flow; it never fails.
 */
export const signOutFlow = (steps: {
  readonly call: () => PromiseLike<{ readonly error: AuthErrorInput["error"] }>;
  readonly fail: () => void;
  readonly leave: () => PromiseLike<void>;
}): Effect.Effect<void> =>
  betterAuthCall(steps.call).pipe(
    Effect.matchEffect({
      onFailure: () => Effect.sync(steps.fail),
      onSuccess: () => Effect.promise(steps.leave),
    }),
  );
