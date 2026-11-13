import * as Cloudflare from "@alchemy.run/cloudflare";
import { assert, describe, it } from "@effect/vitest";
import { Context, DateTime, Effect, Layer, Option, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { LiveKnobs, fromSource } from "@workspace/config/knob";
import { LogLevelKnob } from "@workspace/config/log-level";
import { DOCS_PATH, LLMS_PATH, OPENAPI_PATH } from "@workspace/contract/api/docs-paths";
import { Session, UserId } from "@workspace/contract/domain/session";
import { makeHandler } from "../worker.ts";
import { Notes } from "./notes.ts";
import type { NotesService } from "./notes.ts";

/**
 * The status each documentation path answers through `makeHandler`, with the Worker's bindings
 * set to `env` and the live source holding `live` under `DOCS_ENABLED`.
 */
const docsStatuses = (
  env: { readonly DOCS_ENABLED?: string; readonly DOCS_LIVE_READ?: string },
  live: Option.Option<string>,
) =>
  Effect.gen(function* statuses() {
    const notes = yield* Notes.pipe(Effect.provide(Notes.layerMemory));
    const port = fromSource({ name: "test", read: () => Effect.succeed(live) });

    const handler = yield* makeHandler(
      () => Effect.die("The documentation routes never check a session."),
      Context.make(Notes, notes),
      Layer.succeed(LiveKnobs, port),
    );

    return yield* Effect.forEach([OPENAPI_PATH, DOCS_PATH, LLMS_PATH], (path) =>
      handler.pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(new Request(`http://api.internal${path}`)),
        ),
        Effect.map((response) => HttpServerResponse.toWeb(response).status),
        // An unrouted path fails the handler; the server turns that into the 404 it sends.
        Effect.catchTag("HttpServerError", (error) =>
          error.reason._tag === "RouteNotFound" ? Effect.succeed(404) : Effect.fail(error),
        ),
      ),
    );
  }).pipe(
    Effect.scoped,
    Effect.provideService(Cloudflare.WorkerEnvironment, {
      EXAMPLE_FEATURE_ENABLED: "true",
      ...env,
    }),
    Effect.orDie,
  );

describe("the documentation routes of the api Worker", () => {
  it.effect.each([
    {
      env: { DOCS_ENABLED: "true" },
      live: Option.none<string>(),
      name: "on by the deploy-time value",
      status: 200,
    },
    { env: {}, live: Option.none<string>(), name: "off when nothing sets it", status: 404 },
    {
      env: { DOCS_ENABLED: "false", DOCS_LIVE_READ: "true" },
      live: Option.some("true"),
      name: "on by the live value on a stage that reads it",
      status: 200,
    },
    {
      env: { DOCS_ENABLED: "false", DOCS_LIVE_READ: "false" },
      live: Option.some("true"),
      name: "off on prod although the live value is true",
      status: 404,
    },
  ])("answer $status on all three paths: $name", ({ env, live, status }) =>
    Effect.gen(function* answers() {
      assert.deepStrictEqual(yield* docsStatuses(env, live), [status, status, status]);
    }),
  );
});

describe("the notes store of the api Worker", () => {
  const ada = Schema.encodeSync(Session)(
    new Session({
      email: "ada@example.test",
      expiresAt: DateTime.makeUnsafe("2030-01-01T00:00:00Z"),
      image: null,
      name: "ada",
      userId: UserId.make("ada"),
    }),
  );

  /**
   * One request to the notes endpoints, through a handler built for that request alone, as the
   * Worker builds one per execution, over the given notes service.
   */
  const callOn = (notes: NotesService, request: Request) =>
    Effect.gen(function* call() {
      // No live adapter: `LiveKnobs` falls back to its tier (b) default, as with an empty namespace.
      const handler = yield* makeHandler(
        () => Effect.succeed(ada),
        Context.make(Notes, notes),
        Layer.empty,
      );

      const response = yield* handler.pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(request),
        ),
      );

      const web = HttpServerResponse.toWeb(response);
      const text = yield* Effect.promise(() => web.text());

      return {
        json: yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(text),
        status: web.status,
      };
    }).pipe(
      Effect.scoped,
      Effect.provideService(Cloudflare.WorkerEnvironment, { EXAMPLE_FEATURE_ENABLED: "true" }),
      Effect.orDie,
    );

  it.effect("lists a note created by an earlier request on the same worker instance", () =>
    Effect.gen(function* sharedStore() {
      const notes = yield* Notes.pipe(Effect.provide(Notes.layerMemory));

      const created = yield* callOn(
        notes,
        new Request("http://api.internal/api/notes", {
          body: JSON.stringify({ body: "b", title: "t" }),
          headers: { "content-type": "application/json" },
          method: "POST",
        }),
      );

      const listed = yield* callOn(notes, new Request("http://api.internal/api/notes"));

      assert.strictEqual(created.status, 201);
      assert.strictEqual(listed.status, 200);
      assert.strictEqual(Array.isArray(listed.json) ? listed.json.length : -1, 1);
    }),
  );

  it.effect("reads LOG_LEVEL through the LiveKnobs port once per request", () =>
    Effect.gen(function* readsLevel() {
      const reads: Array<string> = [];

      const port = fromSource({
        name: "test",
        read: (key) =>
          Effect.sync(() => {
            reads.push(key);

            return Option.none<string>();
          }),
      });

      const notes = yield* Notes.pipe(Effect.provide(Notes.layerMemory));

      const handler = yield* makeHandler(
        () => Effect.succeed(ada),
        Context.make(Notes, notes),
        Layer.succeed(LiveKnobs, port),
      );

      const levelReads = () => reads.filter((key) => key === LogLevelKnob.key).length;
      const before = levelReads();

      const request = HttpServerRequest.fromWeb(new Request("http://api.internal/api/notes"));

      yield* handler.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request));
      yield* handler.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request));

      assert.strictEqual(levelReads() - before, 2);
    }).pipe(
      Effect.scoped,
      Effect.provideService(Cloudflare.WorkerEnvironment, { EXAMPLE_FEATURE_ENABLED: "true" }),
      Effect.orDie,
    ),
  );
});
