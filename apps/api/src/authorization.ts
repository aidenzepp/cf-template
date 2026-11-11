import type { RpcCallError } from "alchemy/Rpc";
import { Context, Duration, Effect, Layer, Predicate, Schema } from "effect";
import { HttpServerRequest } from "effect/http";
import { LiveKnobs } from "@workspace/config/knob";
import { CurrentUser, SessionMiddleware } from "@workspace/contract/api/authorization";
import { AuthUnavailable, SessionRequired } from "@workspace/contract/domain/auth-errors";
import type { EncodedSession } from "@workspace/auth/contract";
import { Session } from "@workspace/contract/domain/session";
import { AUTH_UNAVAILABLE_RETRY_AFTER_S, AuthCheckSessionTimeoutKnob } from "./config.ts";

/**
 * The `checkSession` method of the `auth` Worker as `api` calls it over its service binding. It
 * answers the encoded session, the wire form `auth` returns, which {@link SessionLookup} decodes
 * with the contract schema. The transport adds its own failures (`RpcCallError`) to the ones `auth`
 * declares; {@link SessionLookup} turns every one of them into `AuthUnavailable`.
 */
export class AuthCheckSession extends Context.Service<
  AuthCheckSession,
  (input: {
    readonly cookie: string;
  }) => Effect.Effect<EncodedSession | null, AuthUnavailable | RpcCallError>
>()("@workspace/api/AuthCheckSession") {}

/**
 * Log that the session check failed and fail with `AuthUnavailable`, so a fault is never read as
 * signed out.
 *
 * The log carries a fixed message and the fault's name only. The error, its message and its cause
 * can carry the request's cookie, so none of them is logged.
 *
 * @param fault - The `_tag` of the failure, or the name of the defect.
 * @returns A failing effect.
 */
const unavailable = (fault: string) =>
  Effect.logWarning("The session check failed.").pipe(
    Effect.annotateLogs({ fault }),
    Effect.andThen(
      Effect.fail(new AuthUnavailable({ retryAfterSeconds: AUTH_UNAVAILABLE_RETRY_AFTER_S })),
    ),
  );

/**
 * The wire form of the answer: the encoded session, or `null` for a signed-out caller.
 */
const decodeAnswer = Schema.decodeUnknownEffect(Schema.NullOr(Session));

/**
 * Resolve the session of a request: the one place `api` asks `auth` who the caller is.
 */
export class SessionLookup extends Context.Service<
  SessionLookup,
  {
    /**
     * Read the whole `Cookie` header of the current request, the empty string when absent, and ask
     * `auth` under the `AUTH_CHECK_SESSION_TIMEOUT_MS` knob. The result is `null` only when `auth`
     * answered that the caller is signed out. A timeout, a transport failure, a failure or defect
     * of `auth`, or an answer that does not decode as a session fails with `AuthUnavailable`; a
     * fault is never anonymous.
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
          Effect.flatMap(decodeAnswer),
          Effect.catch((error) => unavailable(error._tag)),
          Effect.catchDefect((defect) =>
            unavailable(Predicate.isError(defect) ? defect.name : "NonError"),
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
