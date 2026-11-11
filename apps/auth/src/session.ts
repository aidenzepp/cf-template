import { Context, DateTime, Effect, Layer, Predicate } from "effect";
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
 * Log that the session store faulted and fail with {@link AuthUnavailable}, so a fault is never
 * read as signed out.
 *
 * The log carries a fixed message and the fault's name only. A driver error can carry the query
 * parameters, which for a session check include the session token, so neither its message nor its
 * cause is logged.
 *
 * @param fault - The `_tag` of Better Auth's error or the name of the defect.
 * @returns A failing effect.
 */
const unavailable = (fault: string) =>
  Effect.logError("The session store faulted during a session check.", { fault }).pipe(
    Effect.andThen(
      Effect.fail(new AuthUnavailable({ retryAfterSeconds: AUTH_UNAVAILABLE_RETRY_AFTER_S })),
    ),
  );

/**
 * Name a defect for the log without reading its message or cause.
 *
 * @param defect - What the D1 binding, the adapter or the instance build threw.
 * @returns The error's class name, or a fixed word for a value that is not an error.
 */
const faultName = (defect: Parameters<typeof Predicate.isError>[0]): string =>
  Predicate.isError(defect) ? defect.name : "NonError";

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
 * @param instance - Yields the Better Auth instance of the current execution.
 * @returns The `checkSession` method of {@link AuthEntrypoint}.
 */
export const makeCheckSession = (
  instance: Effect.Effect<Pick<AuthInstance, "api">>,
): AuthEntrypoint["checkSession"] =>
  Effect.fn("auth.checkSession")(function* checkSession({ cookie }) {
    const auth = yield* instance.pipe(
      Effect.catchDefect((defect) => unavailable(faultName(defect))),
    );

    const found = yield* auth.api
      .getSession({ headers: new Headers({ cookie }), query: { disableRefresh: true } })
      .pipe(
        Effect.catch((error) => unavailable(error._tag)),
        Effect.catchDefect((defect) => unavailable(faultName(defect))),
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
