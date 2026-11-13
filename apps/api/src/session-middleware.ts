import * as Domain from "@alchemy.run/domain";
import { Effect, Layer, Schema } from "effect";
import { HttpClientRequest, HttpServerRequest } from "effect/http";
import type { Headers } from "effect/http";
import { RpcMiddleware } from "effect/rpc";
import { AuthUnavailable, SessionRequired } from "@workspace/contract/domain/auth-errors";
import { UserId } from "@workspace/contract/domain/session";
import { SessionLookup } from "./authorization.ts";

/**
 * Who sent a command or asked for a read: the signed-in user. It carries the user id only, since
 * it travels with the request into the Durable Object that owns the key.
 */
export class CurrentActor extends Domain.RequestContext<CurrentActor>()(
  "@workspace/api/CurrentActor",
  Schema.Struct({ userId: UserId }),
) {}

/**
 * The Domain session guard. A command, read or stream that lists `middleware: [Session]` runs only
 * for a signed-in caller and gets {@link CurrentActor}; one without it is open. It fails with 401
 * `SessionRequired` for a signed-out caller and 503 `AuthUnavailable` when the session check fails.
 */
export class Session extends RpcMiddleware.Service<Session, { provides: CurrentActor }>()(
  "@workspace/api/Session",
  { error: Schema.Union([SessionRequired, AuthUnavailable]) },
) {}

/**
 * The request {@link SessionLookup} reads, built from the headers the middleware receives, so the
 * lookup sees the caller's `Cookie` header on every transport.
 *
 * @param headers - The headers of the RPC request.
 * @returns A server request carrying those headers.
 */
const requestOf = (headers: Headers.Headers) =>
  HttpServerRequest.fromClientRequest(
    HttpClientRequest.get("/").pipe(HttpClientRequest.setHeaders(headers)),
  );

/**
 * The server half of {@link Session}, over {@link SessionLookup}: `null` fails with
 * `SessionRequired`, a session provides {@link CurrentActor}, and a fault fails with
 * `AuthUnavailable` and never falls through as anonymous. The request span gets a `userId`
 * attribute and the handler's logs a `userId` annotation; no other profile field is tagged.
 */
export const SessionLive = Layer.effect(
  Session,
  Effect.gen(function* buildSession() {
    const lookup = yield* SessionLookup;

    return (effect, { headers }) =>
      Effect.gen(function* authenticate() {
        const session = yield* lookup.current.pipe(
          Effect.provideService(HttpServerRequest.HttpServerRequest, requestOf(headers)),
        );

        if (session === null) {
          return yield* new SessionRequired();
        }

        yield* Effect.annotateCurrentSpan("userId", session.userId);

        return yield* effect.pipe(
          Effect.provideService(CurrentActor, { userId: session.userId }),
          Effect.annotateLogs({ userId: session.userId }),
        );
      });
  }),
);
