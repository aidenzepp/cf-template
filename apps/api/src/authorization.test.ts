import { assert, describe, it } from "@effect/vitest";
import { ConfigProvider, Context, DateTime, Effect, Layer, Logger, Schema } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { RpcCallError } from "alchemy/Rpc";
import { Api } from "@workspace/contract/api/api";
import { Session, UserId } from "@workspace/contract/domain/session";
import { AuthCheckSession, SessionLookup, SessionMiddlewareLive } from "./authorization.ts";
import { ProblemAdapter, layerProblemDetails } from "./problem-details.ts";
import { SystemApiHandlers } from "./system/http.ts";

const ada = new Session({
  email: "ada@example.test",
  expiresAt: DateTime.makeUnsafe("2030-01-01T00:00:00Z"),
  image: null,
  name: "Ada",
  userId: UserId.make("ada"),
});

/**
 * The session as `auth` hands it over the service binding: a real `JSON.stringify` and parse, so
 * the stubs carry plain values and never a class instance.
 *
 * @param session - The session to send.
 * @returns The encoded session.
 */
const wire = (session: Session) =>
  Schema.decodeUnknownSync(Schema.fromJsonString(Schema.toEncoded(Session)))(
    JSON.stringify(session),
  );

/**
 * The whole router stack of the Worker over a stub `AUTH`.
 *
 * @param checkSession - The stub `AUTH`.
 * @returns The layer a web handler is built from.
 */
const stack = (
  checkSession: typeof AuthCheckSession.Service,
  env: Readonly<Record<string, string | number | boolean>>,
) =>
  HttpApiBuilder.layer(Api).pipe(
    Layer.provide(SystemApiHandlers),
    Layer.provide(SessionMiddlewareLive),
    Layer.provide(SessionLookup.layer),
    Layer.provide(Layer.succeed(AuthCheckSession, checkSession)),
    Layer.provide(layerProblemDetails({ includeDetails: false })),
    Layer.provide(HttpServer.layerServices),
    Layer.merge(ProblemAdapter),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
  );

/**
 * Build a web handler over `checkSession` that runs its requests on the test's clock, with no
 * logger.
 *
 * @param checkSession - The stub `AUTH`.
 * @returns A function that sends a request and resolves to its response.
 */
const serve = (checkSession: typeof AuthCheckSession.Service) =>
  Effect.gen(function* serveStack() {
    const { dispose, handler } = HttpRouter.toWebHandler(stack(checkSession, {}), {
      disableLogger: true,
    });

    yield* Effect.addFinalizer(() => Effect.promise(dispose));

    const context = (yield* Effect.context()).pipe(Context.add(Logger.CurrentLoggers, new Set()));

    return (request: Request) => Effect.promise(() => handler(request, context));
  });

/**
 * Read a problem response's body.
 *
 * @param response - A response with a JSON body.
 * @returns The decoded body.
 */
const bodyOf = (response: Response) => Effect.promise(() => response.json());

const sessionRequest = () => new Request("http://api.test/api/session");

describe("GET /api/session", () => {
  it.effect("answers the session of the caller, and null when signed out", () =>
    Effect.gen(function* answers() {
      const signedIn = yield* serve(() => Effect.succeed(wire(ada)));

      const body = yield* Schema.decodeUnknownEffect(Schema.Struct({ userId: Schema.String }))(
        yield* bodyOf(yield* signedIn(sessionRequest())),
      );

      assert.strictEqual(body.userId, "ada");

      const signedOut = yield* serve(() => Effect.succeed(null));
      const response = yield* signedOut(sessionRequest());

      assert.strictEqual(response.status, 200);
      assert.isNull(yield* bodyOf(response));
    }).pipe(Effect.scoped),
  );

  it.effect("answers 503 AuthUnavailable, never null, when the session check faulted", () =>
    Effect.gen(function* faulted() {
      const send = yield* serve(() =>
        Effect.fail(new RpcCallError({ cause: "boom", method: "checkSession" })),
      );

      const response = yield* send(sessionRequest());

      assert.strictEqual(response.status, 503);
      assert.strictEqual(response.headers.get("retry-after"), "5");

      const body = yield* Schema.decodeUnknownEffect(Schema.Struct({ type: Schema.String }))(
        yield* bodyOf(response),
      );

      assert.strictEqual(body.type, "/problems/auth-unavailable");
    }).pipe(Effect.scoped),
  );
});
