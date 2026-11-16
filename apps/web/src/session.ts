import { Cause, Effect, Schema } from "effect";
import { Session } from "@workspace/contract/domain/session";
import { ApiClient } from "./api-client.ts";

/**
 * What the root route knows about the caller. `unknown` means the session could not be read, never
 * that the caller is signed out; it keeps the retry wait of a `503` (whole seconds, as text) for
 * the retry screen.
 *
 * The session is carried in its encoded form because router context is serialized to the browser.
 */
export type SessionState =
  | { readonly _tag: "signedIn"; readonly session: typeof Session.Encoded }
  | { readonly _tag: "signedOut" }
  | { readonly _tag: "unknown"; readonly status?: number; readonly retryAfter?: string };

/**
 * Encode a session for router context, which is serialized to the browser.
 */
const encodeSession = Schema.encodeEffect(Session);

/**
 * The caller is signed out.
 */
const signedOut = { _tag: "signedOut" } as const satisfies SessionState;

/**
 * Read `GET /api/session` once through the typed client and derive the tri-state: `200` with a
 * session is `signedIn`, `200` with `null` and an undeclared `401` are `signedOut`, and anything
 * else is `unknown`. The `503` is the contract's `AuthUnavailable`, so its retry wait comes from
 * the decoded error; it is not converted to a signed-out caller. A transport or decode fault is
 * `unknown` and its cause is dropped, so nothing sensitive is logged.
 */
export const readSession = Effect.gen(function* readSession() {
  const client = yield* ApiClient;
  const session = yield* client.system.session();

  return session === null
    ? signedOut
    : ({
        _tag: "signedIn",
        session: yield* encodeSession(session),
      } as const satisfies SessionState);
}).pipe(
  Effect.catchTags({
    AuthUnavailable: (unavailable) =>
      Effect.succeed({
        _tag: "unknown",
        retryAfter: String(unavailable.retryAfterSeconds),
        status: unavailable.status,
      } as const satisfies SessionState),
    // The contract declares no `401` for `GET /api/session` (a signed-out caller is a `200` with
    // `null`), so the typed client reports one as an undeclared status: a `DecodeError` that
    // still carries the response. Only its status is read.
    HttpClientError: (failure) =>
      failure.reason._tag === "DecodeError" && failure.reason.response.status === 401
        ? Effect.succeed(signedOut)
        : Effect.fail(failure),
  }),
  Effect.catchCauseIf(
    (cause) => !Cause.hasInterruptsOnly(cause),
    () => Effect.succeed({ _tag: "unknown" } as const satisfies SessionState),
  ),
);
