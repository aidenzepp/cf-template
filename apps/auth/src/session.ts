import { Cause, Context, DateTime, Effect, Layer } from "effect";
import { AuthUnavailable } from "@workspace/contract/domain/auth-errors";
import { Session, UserId } from "@workspace/contract/domain/session";
import { AuthService } from "./auth.ts";
import type { AuthInstance } from "./auth.ts";
import type { AuthEntrypoint } from "./contract.ts";

/**
 * How long, in seconds, a caller waits before retrying after the session store faulted.
 */
const AUTH_UNAVAILABLE_RETRY_AFTER_S = 5;

/**
 * The failure of a session check whose store faulted, so a fault is never read as signed out.
 */
const unavailable = Effect.fail(
  new AuthUnavailable({ retryAfterSeconds: AUTH_UNAVAILABLE_RETRY_AFTER_S }),
);

/**
 * Construct `checkSession` over a Better Auth instance.
 *
 * It calls `api.getSession` with the caller's `Cookie` header and `disableRefresh`, so the check
 * reads the signed cookie cache and never extends the session or writes a cookie. There is no
 * `fresh` parameter and no switch that skips the cache: a re-authentication prompt follows the
 * server's own fresh-session refusal.
 *
 * Better Auth's `null` means signed out and nothing else. Every failure of the store, whether an
 * `APIError` Better Auth raised or a defect from the D1 binding or the adapter, fails with
 * {@link AuthUnavailable}, never `null`. Interruption is not a fault and passes through.
 *
 * @param auth - The Better Auth instance.
 * @returns The `checkSession` method of {@link AuthEntrypoint}.
 */
export const makeCheckSession = (auth: Pick<AuthInstance, "api">): AuthEntrypoint["checkSession"] =>
  Effect.fn("auth.checkSession")(function* checkSession({ cookie }) {
    const found = yield* auth.api
      .getSession({ headers: new Headers({ cookie }), query: { disableRefresh: true } })
      .pipe(
        Effect.tapCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.logError("The session store faulted during a session check.", cause),
        ),
        Effect.catch(() => unavailable),
        Effect.catchDefect(() => unavailable),
      );

    return found === null
      ? null
      : new Session({
          email: found.user.email,
          expiresAt: DateTime.fromDateUnsafe(found.session.expiresAt),
          image: found.user.image ?? null,
          name: found.user.name,
          userId: UserId.make(found.user.id),
        });
  });

/**
 * The `checkSession` capability of the `auth` Worker, a service so the Worker's default
 * entrypoint and its tests read the same method.
 */
export class CheckSession extends Context.Service<CheckSession, AuthEntrypoint["checkSession"]>()(
  "@workspace/auth/CheckSession",
) {
  /**
   * `checkSession` over the Worker's Better Auth instance.
   */
  static readonly layer = Layer.effect(
    CheckSession,
    AuthService.pipe(Effect.map(makeCheckSession)),
  );
}
