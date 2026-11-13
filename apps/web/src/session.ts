import { Cause, Effect, Schema } from "effect";
import { Session } from "@workspace/contract/domain/session";
import { ApiClient } from "./api-client.ts";

/**
 * What the root route knows about the caller. `unknown` means the session could not be read, never
 * that the caller is signed out; it keeps the `Retry-After` of a `503` for the retry screen.
 *
 * The session is carried in its encoded form because router context is serialized to the browser.
 */
export type SessionState =
  | { readonly _tag: "signedIn"; readonly session: typeof Session.Encoded }
  | { readonly _tag: "signedOut" }
  | { readonly _tag: "unknown"; readonly status?: number; readonly retryAfter?: string };

/**
 * Decode the body of a `200` with the contract schema: a session, or `null` for a signed-out
 * caller.
 */
const decodeSession = Schema.decodeUnknownEffect(Schema.NullOr(Session));

/**
 * Encode a session for router context, which is serialized to the browser.
 */
const encodeSession = Schema.encodeEffect(Session);

/**
 * Read `GET /api/session` once and derive the tri-state: `200` with a session is `signedIn`, `200`
 * with `null` and `401` are `signedOut`, and anything else is `unknown`. A `503` is not converted.
 * A transport or decode fault is `unknown` and its cause is dropped, so nothing sensitive is
 * logged.
 */
export const readSession = Effect.gen(function* readSession() {
  const client = yield* ApiClient;
  const response = yield* client.system.session({ responseMode: "response-only" });

  if (response.status === 401) {
    return { _tag: "signedOut" } as const satisfies SessionState;
  }

  if (response.status !== 200) {
    const retryAfter = response.headers["retry-after"];

    return retryAfter === undefined
      ? ({ _tag: "unknown", status: response.status } as const satisfies SessionState)
      : ({ _tag: "unknown", retryAfter, status: response.status } as const satisfies SessionState);
  }

  const session = yield* response.json.pipe(Effect.flatMap(decodeSession));

  return session === null
    ? ({ _tag: "signedOut" } as const satisfies SessionState)
    : ({
        _tag: "signedIn",
        session: yield* encodeSession(session),
      } as const satisfies SessionState);
}).pipe(
  Effect.catchCause((cause) =>
    Cause.hasInterruptsOnly(cause)
      ? Effect.failCause(cause)
      : Effect.succeed({ _tag: "unknown" } as const satisfies SessionState),
  ),
);
