import { Data, Effect } from "effect";
import type { AuthErrorInput } from "./auth-error-copy.ts";

/**
 * The code Better Auth answers with when a sensitive action needs a fresher session. The server
 * decides this; the client never measures the session's age.
 */
export const FRESH_SESSION_CODE = "SESSION_NOT_FRESH";

/**
 * What a failed call knows: the client's `error`, or `{ status: 0 }` for a call that rejected
 * before any response arrived.
 */
type CallError = NonNullable<AuthErrorInput["error"]>;

/**
 * A Better Auth call was refused or never answered.
 */
export class AuthCallFailed extends Data.TaggedError("AuthCallFailed")<{
  readonly error: CallError;
}> {}

/**
 * The server refused a call because the session is too old for it. The caller asks for the
 * password again, then runs the call again.
 */
export class SessionNotFresh extends Data.TaggedError("SessionNotFresh")<{
  readonly error: CallError;
}> {}

/**
 * What a Better Auth client call settles with: `error` is set when the call failed.
 */
export interface Settled {
  readonly data?: unknown;
  readonly error: AuthErrorInput["error"];
}

/**
 * Runs a Better Auth client call as an effect, the one adapter for every call of `web`. A response
 * with an `error` fails with `SessionNotFresh` for the stale-session code and `AuthCallFailed` for
 * any other; a call that rejects fails with `AuthCallFailed` at status 0. Interrupting the effect
 * aborts the signal the call receives.
 *
 * @param call - The client call, given the signal that aborts it.
 * @returns The effect of the call's `data`.
 */
export const betterAuthCall = (call: (signal: AbortSignal) => PromiseLike<Settled>) =>
  Effect.tryPromise({
    catch: () => new AuthCallFailed({ error: { status: 0 } }),
    try: call,
  }).pipe(
    Effect.flatMap(({ data, error }) => {
      if (error === null) {
        return Effect.succeed(data);
      }

      return Effect.fail(
        error.code === FRESH_SESSION_CODE
          ? new SessionNotFresh({ error })
          : new AuthCallFailed({ error }),
      );
    }),
  );
