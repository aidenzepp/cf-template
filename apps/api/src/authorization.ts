import type { RpcCallError } from "alchemy/Rpc";
import { Context, Duration, Effect, Layer } from "effect";
import { HttpServerRequest } from "effect/http";
import { LiveKnobs } from "@workspace/config/knob";
import { CurrentUser, SessionMiddleware } from "@workspace/contract/api/authorization";
import { AuthUnavailable, SessionRequired } from "@workspace/contract/domain/auth-errors";
import type { Session } from "@workspace/contract/domain/session";
import { AUTH_UNAVAILABLE_RETRY_AFTER_S, AuthCheckSessionTimeoutKnob } from "./config.ts";

/**
 * The `checkSession` method of the `auth` Worker as `api` calls it over its service binding. The
 * failure channel is `unknown` because the transport adds its own failures (`RpcCallError`) to the
 * ones `auth` declares; {@link SessionLookup} turns every one of them into `AuthUnavailable`.
 */
export class AuthCheckSession extends Context.Service<
  AuthCheckSession,
  (input: {
    readonly cookie: string;
  }) => Effect.Effect<Session | null, AuthUnavailable | RpcCallError>
>()("@workspace/api/AuthCheckSession") {}

/**
 * Resolve the session of a request: the one place `api` asks `auth` who the caller is.
 */
export class SessionLookup extends Context.Service<
  SessionLookup,
  {
    /**
     * Read the whole `Cookie` header of the current request, the empty string when absent, and ask
     * `auth` under the `AUTH_CHECK_SESSION_TIMEOUT_MS` knob. The result is `null` only when `auth`
     * answered that the caller is signed out. A timeout, a transport failure or a failure of `auth`
     * fails with `AuthUnavailable`; a fault is never anonymous.
     */
    readonly current: Effect.Effect<
      Session | null,
      AuthUnavailable,
      HttpServerRequest.HttpServerRequest
    >;
  }
>()("@workspace/api/SessionLookup") {
  /**
   * The lookup over {@link AuthCheckSession}, with the timeout read from its knob.
   */
  static readonly layer = Layer.effect(
    SessionLookup,
    Effect.gen(function* buildLookup() {
      const checkSession = yield* AuthCheckSession;
      const knobs = yield* LiveKnobs;
      const timeoutMs = yield* knobs.bind(AuthCheckSessionTimeoutKnob);

      const current = Effect.gen(function* lookup() {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const timeout = Duration.millis(yield* timeoutMs);

        return yield* checkSession({ cookie: request.headers.cookie ?? "" }).pipe(
          Effect.timeout(timeout),
          Effect.catch((error) =>
            // The error itself is never logged: its cause can carry the request's cookie.
            Effect.logWarning("The session check failed.").pipe(
              Effect.annotateLogs({
                errorTag: error._tag,
              }),
              Effect.andThen(
                Effect.fail(
                  new AuthUnavailable({ retryAfterSeconds: AUTH_UNAVAILABLE_RETRY_AFTER_S }),
                ),
              ),
            ),
          ),
        );
      });

      return SessionLookup.of({ current });
    }),
  );
}

/**
 * The implementation of `SessionMiddleware`: one path and one authority. `null` from `auth` fails
 * with 401 `SessionRequired`; a session provides `CurrentUser`; a fault fails with 503
 * `AuthUnavailable` and never falls through as anonymous.
 */
export const SessionMiddlewareLive = Layer.effect(
  SessionMiddleware,
  Effect.gen(function* buildSessionMiddleware() {
    const lookup = yield* SessionLookup;

    return SessionMiddleware.of((httpEffect) =>
      Effect.gen(function* authorize() {
        const session = yield* lookup.current;

        return session === null
          ? yield* new SessionRequired()
          : yield* Effect.provideService(httpEffect, CurrentUser, session);
      }),
    );
  }),
);
