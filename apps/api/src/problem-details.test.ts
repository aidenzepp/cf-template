import { assert, describe, it } from "@effect/vitest";
import { ByteSize, Context, DateTime, Effect, ErrorReporter, Layer, Schema } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
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
 * Serve the whole router stack of the Worker with a `1 kB` body limit and no error reporter.
 *
 * @param options - The stack's settings.
 * @param options.includeDetails - The `PROBLEM_DETAILS_INCLUDE` value.
 * @returns A function that sends a request and resolves to its response.
 */
const serve = (options: { readonly includeDetails: boolean }) =>
  Effect.gen(function* serveStack() {
    const layer = HttpApiBuilder.layer(Api).pipe(
      Layer.provide(SystemApiHandlers),
      Layer.provide(SessionMiddlewareLive),
      Layer.provide(SessionLookup.layer),
      Layer.provide(Layer.succeed(AuthCheckSession, () => Effect.succeed(wire(ada)))),
      Layer.provide(layerProblemDetails({ includeDetails: options.includeDetails })),
      Layer.provide(HttpServer.layerServices),
      Layer.merge(ProblemAdapter),
    );

    const { dispose, handler } = HttpRouter.toWebHandler(layer, { disableLogger: true });

    yield* Effect.addFinalizer(() => Effect.promise(dispose));

    const context = Context.make(HttpServerRequest.MaxBodySize, ByteSize.kilobytes(1)).pipe(
      Context.add(ErrorReporter.CurrentErrorReporters, new Set()),
    );

    return (request: Request) => Effect.promise(() => handler(request, context));
  });

/**
 * Assert a response is a bare `about:blank` problem with the given status and phrase.
 *
 * @param response - The response to check.
 * @param status - The expected status.
 * @param title - The expected IANA phrase.
 * @returns An effect that asserts.
 */
const assertBlank = (response: Response, status: number, title: string) =>
  Effect.gen(function* blank() {
    assert.strictEqual(response.status, status);
    assert.match(response.headers.get("content-type") ?? "", /^application\/problem\+json/u);
    assert.deepStrictEqual(yield* Effect.promise(() => response.json()), {
      status,
      title,
      type: "about:blank",
    });
  });

describe("the adapter", () => {
  const defaults = { includeDetails: false };

  it.effect("turns an unrouted path into a problem", () =>
    Effect.gen(function* unrouted() {
      const send = yield* serve(defaults);

      yield* assertBlank(yield* send(new Request("http://api.test/nope")), 404, "Not Found");
    }).pipe(Effect.scoped),
  );

  it.effect("turns a wrong method into a problem", () =>
    Effect.gen(function* wrongMethod() {
      const send = yield* serve(defaults);
      const response = yield* send(new Request("http://api.test/api/health", { method: "PUT" }));

      assert.isAtLeast(response.status, 400);
      assert.match(response.headers.get("content-type") ?? "", /^application\/problem\+json/u);
    }).pipe(Effect.scoped),
  );
});
