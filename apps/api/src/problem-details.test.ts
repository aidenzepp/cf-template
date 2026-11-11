import { assert, describe, it } from "@effect/vitest";
import {
  ByteSize,
  ConfigProvider,
  Context,
  DateTime,
  Effect,
  ErrorReporter,
  Layer,
  Ref,
  Schema,
} from "effect";
import { HttpRouter, HttpServer, HttpServerRequest } from "effect/http";
import { HttpApiBuilder, HttpApiError } from "effect/http-api";
import { Api } from "@workspace/contract/api/api";
// block:notes start
import { NOTE_TITLE_MAX_LENGTH } from "@workspace/contract/domain/note";
// block:notes end
import { Session, UserId } from "@workspace/contract/domain/session";
import { AuthCheckSession, SessionLookup, SessionMiddlewareLive } from "./authorization.ts";
// block:notes start
import { ExampleFeatureGateLive } from "./notes/gate.ts";
import { NotesApiHandlersNoDeps } from "./notes/http.ts";
import { Notes } from "./notes/notes.ts";
// block:notes end
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
 * A `Notes` whose `list` dies with `defect`, so a test can make the handler fault.
 *
 * @param defect - The value `list` dies with.
 * @returns The layer.
 */
const dyingNotes = (defect: Error) =>
  Layer.succeed(
    Notes,
    Notes.of({
      create: () => Effect.die(defect),
      get: () => Effect.die(defect),
      list: () => Effect.die(defect),
      remove: () => Effect.die(defect),
      update: () => Effect.die(defect),
    }),
  );

/**
 * Serve the whole router stack of the Worker with a `1 kB` body limit and the given error reporter.
 *
 * @param options - The stack's settings.
 * @param options.includeDetails - The `PROBLEM_DETAILS_INCLUDE` value.
 * @param options.notes - The `Notes` implementation.
 * @param options.reporter - The error reporter that observes the stack.
 * @returns A function that sends a request and resolves to its response.
 */
const serve = (options: {
  readonly includeDetails: boolean;
  readonly notes: Layer.Layer<Notes>;
  readonly reporter?: ErrorReporter.ErrorReporter;
}) =>
  Effect.gen(function* serveStack() {
    const layer = HttpApiBuilder.layer(Api).pipe(
      Layer.provide(
        Layer.mergeAll(NotesApiHandlersNoDeps, SystemApiHandlers).pipe(
          Layer.provide(options.notes),
        ),
      ),
      Layer.provide([SessionMiddlewareLive, ExampleFeatureGateLive]),
      Layer.provide(SessionLookup.layer),
      Layer.provide(Layer.succeed(AuthCheckSession, () => Effect.succeed(wire(ada)))),
      Layer.provide(layerProblemDetails({ includeDetails: options.includeDetails })),
      Layer.provide(HttpServer.layerServices),
      Layer.merge(ProblemAdapter),
      Layer.provide(
        ConfigProvider.layer(ConfigProvider.fromUnknown({ EXAMPLE_FEATURE_ENABLED: "true" })),
      ),
    );

    const { dispose, handler } = HttpRouter.toWebHandler(layer, { disableLogger: true });

    yield* Effect.addFinalizer(() => Effect.promise(dispose));

    const context = Context.make(HttpServerRequest.MaxBodySize, ByteSize.kilobytes(1)).pipe(
      Context.add(
        ErrorReporter.CurrentErrorReporters,
        new Set(options.reporter === undefined ? [] : [options.reporter]),
      ),
    );

    return (request: Request) => Effect.promise(() => handler(request, context));
  });

const json = (path: string, method: string, body: string, contentType = "application/json") =>
  new Request(`http://api.test${path}`, {
    body,
    headers: { "content-type": contentType },
    method,
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
  const defaults = { includeDetails: false, notes: Notes.layerMemory };

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

  it.effect("turns a body over the limit into a 413 problem", () =>
    Effect.gen(function* tooLarge() {
      const send = yield* serve(defaults);
      const body = JSON.stringify({ body: "x".repeat(2048), title: "big" });

      yield* assertBlank(yield* send(json("/api/notes", "POST", body)), 413, "Content Too Large");
    }).pipe(Effect.scoped),
  );

  it.effect("turns an unsupported media type into a 415 problem", () =>
    Effect.gen(function* unsupported() {
      const send = yield* serve(defaults);

      yield* assertBlank(
        yield* send(json("/api/notes", "POST", "title=x", "text/plain")),
        415,
        "Unsupported Media Type",
      );
    }).pipe(Effect.scoped),
  );

  it.effect("turns a defect into a 500 problem and still reports the original defect", () =>
    Effect.gen(function* defect() {
      const reports = yield* Ref.make<ReadonlyArray<string>>([]);

      const reporter = ErrorReporter.make(({ error }) => {
        Effect.runSync(Ref.update(reports, (all) => [...all, error.message]));
      });

      const send = yield* serve({
        ...defaults,
        notes: dyingNotes(new Error("kaboom")),
        reporter,
      });

      yield* assertBlank(
        yield* send(new Request("http://api.test/api/notes")),
        500,
        "Internal Server Error",
      );
      assert.isTrue((yield* Ref.get(reports)).some((message) => message.includes("kaboom")));
    }).pipe(Effect.scoped),
  );

  it.effect("turns a raw built-in error into a problem", () =>
    Effect.gen(function* builtIn() {
      const send = yield* serve({ ...defaults, notes: dyingNotes(new HttpApiError.Conflict()) });

      yield* assertBlank(yield* send(new Request("http://api.test/api/notes")), 409, "Conflict");
    }).pipe(Effect.scoped),
  );

  it.effect("passes a declared Problem through unchanged", () =>
    Effect.gen(function* declared() {
      const send = yield* serve(defaults);
      const response = yield* send(new Request("http://api.test/api/notes/missing"));

      assert.strictEqual(response.status, 404);
      assert.isNull(response.headers.get("retry-after"));
      assert.deepStrictEqual(yield* Effect.promise(() => response.json()), {
        id: "missing",
        status: 404,
        title: "Note not found",
        type: "/problems/note-not-found",
      });
    }).pipe(Effect.scoped),
  );
});

describe("note size caps", () => {
  it.effect("answers 400 for a title or body over its cap and stores nothing", () =>
    Effect.gen(function* oversized() {
      const send = yield* serve({ includeDetails: false, notes: Notes.layerMemory });

      const title = yield* send(
        json(
          "/api/notes",
          "POST",
          JSON.stringify({ body: "b", title: "t".repeat(NOTE_TITLE_MAX_LENGTH + 1) }),
        ),
      );

      const patch = yield* send(
        json(
          "/api/notes/any",
          "PATCH",
          JSON.stringify({ title: "t".repeat(NOTE_TITLE_MAX_LENGTH + 1) }),
        ),
      );

      for (const response of [title, patch]) {
        assert.strictEqual(response.status, 400);
        assert.match(response.headers.get("content-type") ?? "", /^application\/problem\+json/u);
        assert.deepStrictEqual(yield* Effect.promise(() => response.json()), {
          detail: "Request validation failed",
          status: 400,
          title: "Bad Request",
          type: "about:blank",
        });
      }
    }).pipe(Effect.scoped),
  );
});

describe("PROBLEM_DETAILS_INCLUDE", () => {
  const secret = "hunter2-SECRET-VALUE";

  const decodeFailures = [
    [
      "a wrong type with an unexpected key",
      JSON.stringify({ body: "b", password: secret, title: 5 }),
    ],
    ["a body of the wrong kind", JSON.stringify([secret])],
    ["a nested value", JSON.stringify({ body: { token: secret }, title: { token: secret } })],
  ] as const;

  it.effect.each(decodeFailures)("answers 400 and echoes no request value for %s", ([, body]) =>
    Effect.gen(function* decodeFailure() {
      for (const includeDetails of [false, true]) {
        const send = yield* serve({ includeDetails, notes: Notes.layerMemory });
        const response = yield* send(json("/api/notes", "POST", body));
        const text = yield* Effect.promise(() => response.text());

        assert.strictEqual(response.status, 400);
        assert.match(response.headers.get("content-type") ?? "", /^application\/problem\+json/u);
        assert.notInclude(text, secret);
        assert.strictEqual(text.includes('"errors"'), includeDetails);
      }
    }).pipe(Effect.scoped),
  );
});
