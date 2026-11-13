import * as Domain from "@alchemy.run/domain";
import { assert, describe, it } from "@effect/vitest";
import * as Http from "alchemy/Http";
import { ByteSize, Context, DateTime, Effect, ErrorReporter, Layer, Ref, Schema } from "effect";
import { HttpRouter, HttpServerRequest } from "effect/http";
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiError,
  HttpApiGroup,
  HttpApiMiddleware,
} from "effect/http-api";
import { SystemApi } from "@workspace/contract/api/system";
import { Session, UserId } from "@workspace/contract/domain/session";
import { AuthCheckSession, SessionLookup, SessionMiddlewareLive } from "./authorization.ts";
import { NotebookHttp } from "./docs/routes.ts";
import { NOTE_TITLE_MAX_LENGTH } from "./notes/note.command.ts";
import { NotesModel } from "./notes/notes.model.ts";
import { ProblemAdapter, layerProblemDetails } from "./problem-details.ts";
import { SessionLive } from "./session-middleware.ts";
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
 * Test-local endpoints: two whose handlers fault, since no served route can be made to fault on
 * demand, and one that decodes a payload, since the Notebook group sits outside `ProblemDetails`.
 */
const ProbeGroup = HttpApiGroup.make("probe")
  .add(HttpApiEndpoint.get("defect", "/api/probe/defect"))
  .add(HttpApiEndpoint.get("conflict", "/api/probe/conflict"))
  .add(
    HttpApiEndpoint.post("echo", "/api/probe/echo", {
      payload: Schema.Struct({ body: Schema.String, title: Schema.String }),
    }),
  );

/**
 * The served Api's shape with the probe group among the groups `ProblemDetails` wraps: the
 * contract's groups, then the middleware, then the Notebook group under `/api`, as `ServedApi`.
 */
const ProbedApi = HttpApi.make("Api")
  .add(SystemApi)
  .add(ProbeGroup)
  .middleware(HttpApiMiddleware.ProblemDetails)
  .add(NotebookHttp.group.prefix("/api"));

/**
 * The probe handlers: `defect` dies with `defect`, `conflict` dies with a raw built-in error and
 * `echo` answers nothing.
 *
 * @param defect - The value the `defect` endpoint dies with.
 * @returns The handler layer.
 */
const probeHandlers = (defect: Error) =>
  HttpApiBuilder.group(ProbedApi, "probe", (handlers) =>
    handlers
      .handle("defect", () => Effect.die(defect))
      .handle("conflict", () => Effect.die(new HttpApiError.Conflict()))
      .handle("echo", () => Effect.void),
  );

/**
 * Serve the router stack of the Worker, the Notebook group hosted in memory beside the probe
 * group, signed in as Ada, with a `1 kB` body limit and the given error reporter.
 *
 * @param options - The stack's settings.
 * @param options.includeDetails - The `PROBLEM_DETAILS_INCLUDE` value.
 * @param options.reporter - The error reporter that observes the stack.
 * @param options.signedIn - Whether `auth` answers with Ada's session or with `null`.
 * @returns A function that sends a request and resolves to its response.
 */
const serve = (options: {
  readonly includeDetails: boolean;
  readonly reporter?: ErrorReporter.ErrorReporter;
  readonly signedIn?: boolean;
}) =>
  Effect.gen(function* serveStack() {
    const notebook = NotebookHttp.layerFor(ProbedApi).pipe(
      Layer.provide(SessionLive),
      Layer.provide(NotesModel.layer(Layer.empty).pipe(Layer.provide(Domain.InMemory))),
    );

    const layer = HttpApiBuilder.layer(ProbedApi).pipe(
      Layer.provide(
        Layer.mergeAll(SystemApiHandlers, notebook, probeHandlers(new Error("kaboom"))),
      ),
      Layer.provide(SessionMiddlewareLive),
      Layer.provide(SessionLookup.layer),
      Layer.provide(
        Layer.succeed(AuthCheckSession, () =>
          Effect.succeed(options.signedIn === false ? null : wire(ada)),
        ),
      ),
      Layer.provide(layerProblemDetails({ includeDetails: options.includeDetails })),
      Layer.provide(Http.Platform),
      Layer.merge(ProblemAdapter),
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
 * A JSON value: what a test may put in a request body, well formed or not.
 */
type Json =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<Json>
  | { readonly [key: string]: Json };

/**
 * A `CreateNote` command body for Ada's notebook.
 *
 * @param input - The note fields, any JSON value so a test can send a malformed one.
 * @returns The JSON body.
 */
const createNote = (input: Json) => JSON.stringify({ commandId: "c-1", input, target: "ada" });

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

  it.effect("turns a body over the limit into a 413 problem", () =>
    Effect.gen(function* tooLarge() {
      const send = yield* serve(defaults);
      const body = createNote({ body: "x".repeat(2048), id: "n-1", title: "big" });

      yield* assertBlank(
        yield* send(json("/api/CreateNote", "POST", body)),
        413,
        "Content Too Large",
      );
    }).pipe(Effect.scoped),
  );

  it.effect("turns an unsupported media type into a 415 problem", () =>
    Effect.gen(function* unsupported() {
      const send = yield* serve(defaults);

      yield* assertBlank(
        yield* send(json("/api/CreateNote", "POST", "title=x", "text/plain")),
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

      const send = yield* serve({ ...defaults, reporter });

      yield* assertBlank(
        yield* send(new Request("http://api.test/api/probe/defect")),
        500,
        "Internal Server Error",
      );
      assert.isTrue((yield* Ref.get(reports)).some((message) => message.includes("kaboom")));
    }).pipe(Effect.scoped),
  );

  it.effect("turns a raw built-in error into a problem", () =>
    Effect.gen(function* builtIn() {
      const send = yield* serve(defaults);

      yield* assertBlank(
        yield* send(new Request("http://api.test/api/probe/conflict")),
        409,
        "Conflict",
      );
    }).pipe(Effect.scoped),
  );

  it.effect("passes a declared Problem through unchanged", () =>
    Effect.gen(function* declared() {
      const send = yield* serve({ ...defaults, signedIn: false });

      const response = yield* send(
        json("/api/CreateNote", "POST", createNote({ body: "", id: "n-1", title: "t" })),
      );

      assert.strictEqual(response.status, 401);
      assert.isNull(response.headers.get("retry-after"));
      assert.deepStrictEqual(yield* Effect.promise(() => response.json()), {
        status: 401,
        title: "Sign-in required",
        type: "/problems/session-required",
      });
    }).pipe(Effect.scoped),
  );
});

describe("note size caps", () => {
  it.effect("answers 400 for a title over its cap and stores nothing", () =>
    Effect.gen(function* oversized() {
      const send = yield* serve({ includeDetails: false });

      // The Notebook group sits outside `ProblemDetails`, so its decode failure is a bare 400.
      yield* assertBlank(
        yield* send(
          json(
            "/api/CreateNote",
            "POST",
            createNote({ body: "b", id: "n-1", title: "t".repeat(NOTE_TITLE_MAX_LENGTH + 1) }),
          ),
        ),
        400,
        "Bad Request",
      );

      const created = yield* send(
        json("/api/CreateNote", "POST", createNote({ body: "b", id: "n-1", title: "t" })),
      );

      assert.isBelow(created.status, 300);
    }).pipe(Effect.scoped),
  );
});

describe("PROBLEM_DETAILS_INCLUDE", () => {
  const secret = "hunter2-SECRET-VALUE";

  const decodeFailures = [
    ["a wrong type with an unexpected key", { body: "b", id: "n-1", password: secret, title: 5 }],
    ["a body of the wrong kind", [secret]],
    ["a nested value", { body: { token: secret }, id: "n-1", title: { token: secret } }],
  ] as const;

  it.effect.each(decodeFailures)("answers 400 and echoes no request value for %s", ([, value]) =>
    Effect.gen(function* decodeFailure() {
      for (const includeDetails of [false, true]) {
        const send = yield* serve({ includeDetails });
        const response = yield* send(json("/api/probe/echo", "POST", JSON.stringify(value)));
        const text = yield* Effect.promise(() => response.text());

        assert.strictEqual(response.status, 400);
        assert.match(response.headers.get("content-type") ?? "", /^application\/problem\+json/u);
        assert.notInclude(text, secret);
        assert.strictEqual(text.includes('"errors"'), includeDetails);
      }
    }).pipe(Effect.scoped),
  );

  it.effect.each(decodeFailures)(
    "answers a Notebook command 400 and echoes no request value for %s",
    ([, value]) =>
      Effect.gen(function* notebookDecodeFailure() {
        for (const includeDetails of [false, true]) {
          const send = yield* serve({ includeDetails });
          const body = Array.isArray(value) ? JSON.stringify(value) : createNote(value);
          const response = yield* send(json("/api/CreateNote", "POST", body));
          const text = yield* Effect.promise(() => response.text());

          assert.strictEqual(response.status, 400);
          assert.notInclude(text, secret);
        }
      }).pipe(Effect.scoped),
  );
});
