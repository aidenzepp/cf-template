import { assert, describe, it } from "@effect/vitest";
import {
  ConfigProvider,
  Context,
  DateTime,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Logger,
  References,
  Ref,
  Schema,
  Tracer,
} from "effect";
import { TestClock } from "effect/testing";
import * as Domain from "@alchemy.run/domain";
import * as Http from "alchemy/Http";
import { HttpRouter } from "effect/http";
import { Rpc, RpcGroup, RpcTest } from "effect/rpc";
import { HttpApiBuilder } from "effect/http-api";
import { RpcCallError } from "alchemy/Rpc";
import { Session, UserId } from "@workspace/contract/domain/session";
import { AuthCheckSession, SessionLookup } from "./authorization.ts";
import { NotebookHttp, ServedApi } from "./docs/routes.ts";
import { NoteIndexUnstored } from "./notes/note-index.projection.ts";
import { NotesModel } from "./notes/notes.model.ts";
import { ProblemAdapter, layerProblemDetails } from "./problem-details.ts";
import { Session as SessionGuard, SessionLive } from "./session-middleware.ts";
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
  Schema.decodeSync(Schema.fromJsonString(Schema.toEncoded(Session)))(JSON.stringify(session));

/**
 * The whole router stack of the Worker over a stub `AUTH`, the Notebook group hosted in memory.
 *
 * @param checkSession - The stub `AUTH`.
 * @param env - The Worker bindings the knobs are read from.
 * @returns The layer a web handler is built from.
 */
const stack = (
  checkSession: typeof AuthCheckSession.Service,
  env: Readonly<Record<string, string | number | boolean>>,
) =>
  HttpApiBuilder.layer(ServedApi).pipe(
    Layer.provide(
      Layer.mergeAll(
        SystemApiHandlers,
        NotebookHttp.layerFor(ServedApi).pipe(
          Layer.provide(SessionLive),
          Layer.provide(NotesModel.layer(NoteIndexUnstored).pipe(Layer.provide(Domain.InMemory))),
        ),
      ),
    ),
    Layer.provide(SessionLookup.layer),
    Layer.provide(Layer.succeed(AuthCheckSession, checkSession)),
    Layer.provide(layerProblemDetails({ includeDetails: false })),
    Layer.provide(Http.Platform),
    Layer.merge(ProblemAdapter),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
  );

/**
 * Build a web handler over `checkSession` that runs its requests on the test's clock.
 *
 * @param checkSession - The stub `AUTH`.
 * @param options - Optional settings.
 * @param options.env - The Worker bindings the knobs are read from; none by default.
 * @param options.logger - A logger that sees every log line of the requests.
 * @param options.tracer - A tracer that sees every span of the requests.
 * @returns A function that sends a request and resolves to its response.
 */
const serve = (
  checkSession: typeof AuthCheckSession.Service,
  options: {
    readonly env?: Readonly<Record<string, string | number | boolean>>;
    readonly logger?: Logger.Logger<unknown, void>;
    readonly tracer?: Tracer.Tracer;
  } = {},
) =>
  Effect.gen(function* serveStack() {
    const { dispose, handler } = HttpRouter.toWebHandler(stack(checkSession, options.env ?? {}), {
      disableLogger: true,
    });

    yield* Effect.addFinalizer(() => Effect.promise(dispose));

    const base = (yield* Effect.context()).pipe(
      Context.add(
        Logger.CurrentLoggers,
        options.logger === undefined ? new Set() : new Set([options.logger]),
      ),
    );

    const context =
      options.tracer === undefined ? base : Context.add(base, Tracer.Tracer, options.tracer);

    return (request: Request) => Effect.promise(() => handler(request, context));
  });

/**
 * A `POST /api/CreateNote` command for Ada's notebook: a route the `Session` middleware guards.
 *
 * @param headers - Extra request headers, such as `cookie`.
 * @returns The request.
 */
const notesRequest = (headers?: Record<string, string>) =>
  new Request("http://api.test/api/CreateNote", {
    body: JSON.stringify({
      commandId: "c-1",
      input: { body: "", id: "n-1", title: "Title" },
      target: "ada",
    }),
    headers: { "content-type": "application/json", ...headers },
    method: "POST",
  });

/**
 * Read a problem response's body.
 *
 * @param response - A response with a JSON body.
 * @returns The decoded body.
 */
const bodyOf = (response: Response) => Effect.promise(() => response.json());

describe("session middleware", () => {
  it.effect("answers 401 SessionRequired when auth returns null", () =>
    Effect.gen(function* signedOut() {
      const send = yield* serve(() => Effect.succeed(null));
      const response = yield* send(notesRequest());

      assert.strictEqual(response.status, 401);
      assert.match(response.headers.get("content-type") ?? "", /^application\/problem\+json/u);
      assert.deepStrictEqual(yield* bodyOf(response), {
        status: 401,
        title: "Sign-in required",
        type: "/problems/session-required",
      });
    }).pipe(Effect.scoped),
  );

  it.effect("answers 503 AuthUnavailable with Retry-After when the binding throws", () =>
    Effect.gen(function* throwing() {
      const send = yield* serve(() =>
        Effect.fail(new RpcCallError({ cause: "boom", method: "checkSession" })),
      );

      const response = yield* send(notesRequest());

      assert.strictEqual(response.status, 503);
      assert.strictEqual(response.headers.get("retry-after"), "5");
      assert.deepStrictEqual(yield* bodyOf(response), {
        retryAfterSeconds: 5,
        status: 503,
        title: "Sign-in service unavailable",
        type: "/problems/auth-unavailable",
      });
    }).pipe(Effect.scoped),
  );

  it.effect("answers 503 after the knob when auth never resolves", () =>
    Effect.gen(function* never() {
      const called = yield* Deferred.make<boolean>();

      const send = yield* serve(() =>
        Deferred.succeed(called, true).pipe(Effect.andThen(Effect.never)),
      );

      const fiber = yield* Effect.forkChild(send(notesRequest()));

      yield* Deferred.await(called);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("1499 millis");

      assert.isUndefined(fiber.pollUnsafe());

      yield* TestClock.adjust("1 millis");

      const response = yield* Fiber.join(fiber);

      assert.strictEqual(response.status, 503);
      assert.strictEqual(response.headers.get("retry-after"), "5");
    }).pipe(Effect.scoped),
  );

  it.effect("passes the whole Cookie header, and the empty string when absent", () =>
    Effect.gen(function* cookies() {
      const seen = yield* Ref.make<ReadonlyArray<string>>([]);

      const send = yield* serve(({ cookie }) =>
        Ref.update(seen, (all) => [...all, cookie]).pipe(Effect.as(wire(ada))),
      );

      yield* send(notesRequest({ cookie: "a=1; __Secure-session=abc.def; b=2" }));
      yield* send(notesRequest());

      assert.deepStrictEqual(yield* Ref.get(seen), ["a=1; __Secure-session=abc.def; b=2", ""]);
    }).pipe(Effect.scoped),
  );

  it.effect("never runs a command for a caller whose session check faulted", () =>
    Effect.gen(function* faulted() {
      const send = yield* serve(() => Effect.fail(new RpcCallError({ cause: 1, method: "x" })));
      const response = yield* send(notesRequest({ cookie: "session=valid" }));

      assert.strictEqual(response.status, 503);
    }).pipe(Effect.scoped),
  );

  it.effect("tags the request span with the caller's userId only", () =>
    Effect.gen(function* taggedSpan() {
      const spans: Array<Tracer.NativeSpan> = [];

      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);

          spans.push(span);

          return span;
        },
      });

      const send = yield* serve(() => Effect.succeed(wire(ada)), { tracer });

      assert.strictEqual((yield* send(notesRequest())).status, 200);
      assert.isTrue(spans.some((span) => span.attributes.get("userId") === "ada"));
      assert.isFalse(spans.some((span) => JSON.stringify([...span.attributes]).includes("@")));
    }).pipe(Effect.scoped),
  );
});

/**
 * A test-local guarded call whose handler writes one log line, since no Notebook handler logs.
 */
const Noted = Rpc.make("Noted").middleware(SessionGuard);

/**
 * The group of {@link Noted}.
 */
const NotedGroup = RpcGroup.make(Noted);

describe("the Session middleware over the lookup", () => {
  it.effect("tags every handler log line with the caller's userId only", () =>
    Effect.gen(function* taggedLogs() {
      const annotated = yield* Ref.make<ReadonlyArray<string>>([]);
      const services = yield* Effect.context();

      // Only the handler's line: building the lookup logs the knob's missing adapter.
      const logger = Logger.make(({ fiber, message }) => {
        if (JSON.stringify(message).includes("noted")) {
          Effect.runSyncWith(services)(
            Ref.update(annotated, (all) => [
              ...all,
              JSON.stringify(fiber.getRef(References.CurrentLogAnnotations)),
            ]),
          );
        }
      });

      const world = Layer.mergeAll(
        NotedGroup.toLayer({ Noted: () => Effect.logInfo("noted") }),
        SessionLive.pipe(
          Layer.provide(SessionLookup.layer),
          Layer.provide(Layer.succeed(AuthCheckSession, () => Effect.succeed(wire(ada)))),
        ),
      );

      yield* Effect.gen(function* call() {
        const client = yield* RpcTest.makeClient(NotedGroup);

        yield* client.Noted(undefined, { headers: { cookie: "session=valid" } });
      }).pipe(
        Effect.scoped,
        Effect.provide(world.pipe(Layer.provideMerge(Logger.layer([logger])))),
      );

      assert.deepStrictEqual(yield* Ref.get(annotated), ['{"userId":"ada"}']);
    }),
  );
});

const sessionRequest = () => new Request("http://api.test/api/session");

describe("an answer or a fault that is not a clean session", () => {
  it.effect.each(["notes", "session"] as const)(
    "answers 503, never 500 or signed out, when the answer does not decode (%s)",
    (route) =>
      Effect.gen(function* undecodable() {
        const send = yield* serve(() => Effect.succeed({ ...wire(ada), expiresAt: "not a date" }));
        const response = yield* send(route === "notes" ? notesRequest() : sessionRequest());

        assert.strictEqual(response.status, 503);
        assert.strictEqual(response.headers.get("retry-after"), "5");
      }).pipe(Effect.scoped),
  );

  it.effect("logs a defect of the check by name only and answers 503", () =>
    Effect.gen(function* defect() {
      const cookie = "session=SECRETCOOKIE-1234";
      const lines = yield* Ref.make<ReadonlyArray<string>>([]);
      const services = yield* Effect.context();

      const logger = Logger.make(({ fiber, message }) => {
        const annotations = fiber.getRef(References.CurrentLogAnnotations);

        Effect.runSyncWith(services)(
          Ref.update(lines, (all) => [...all, JSON.stringify({ annotations, message })]),
        );
      });

      const send = yield* serve(() => Effect.die(new Error(`boom ${cookie}`)), { logger });

      const response = yield* send(notesRequest({ cookie }));

      assert.strictEqual(response.status, 503);

      const logged = yield* Ref.get(lines);

      assert.isTrue(logged.some((line) => line.includes("The session check failed.")));
      assert.isTrue(logged.some((line) => line.includes('"fault":"Error"')));

      for (const line of logged) {
        assert.notInclude(line, "SECRETCOOKIE");
      }
    }).pipe(Effect.scoped),
  );
});

describe("knobs read from the Worker bindings", () => {
  it.effect("reads a native number binding per execution", () =>
    Effect.gen(function* bindings() {
      const called = yield* Deferred.make<boolean>();

      const send = yield* serve(
        () => Deferred.succeed(called, true).pipe(Effect.andThen(Effect.never)),
        { env: { AUTH_CHECK_SESSION_TIMEOUT_MS: 200 } },
      );

      const fiber = yield* Effect.forkChild(send(notesRequest()));

      yield* Deferred.await(called);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("199 millis");

      assert.isUndefined(fiber.pollUnsafe());

      yield* TestClock.adjust("1 millis");

      assert.strictEqual((yield* Fiber.join(fiber)).status, 503);
    }).pipe(Effect.scoped),
  );
});

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
