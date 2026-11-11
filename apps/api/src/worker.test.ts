import * as Cloudflare from "@alchemy.run/cloudflare";
import { assert, describe, it } from "@effect/vitest";
import { DateTime, Effect, Layer, Option, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { LiveKnobs, fromSource } from "@workspace/config/knob";
import { LogLevelKnob } from "@workspace/config/log-level";
import { Session, UserId } from "@workspace/contract/domain/session";
import { Notes } from "./notes/notes.ts";
import type { NotesService } from "./notes/notes.ts";
import type ApiWorker from "./worker.ts";
import { ApiDeployment, apiProps, apiTelemetry, makeHandler } from "./worker.ts";

/**
 * The services the Worker's layer still needs from its provider. `ApiDeployment` must not be one:
 * only `infra` provides it, and the deployed bundle evaluates the module without it.
 */
type NeededServices = Layer.Services<typeof ApiWorker>;

describe("the api Worker module", () => {
  it("does not require ApiDeployment", () => {
    const needsNoDeployment: [ApiDeployment] extends [NeededServices] ? false : true = true;

    assert.isTrue(needsNoDeployment);
  });

  it.effect("evaluates its properties with no provider, as the deployed bundle does", () =>
    Effect.gen(function* withoutDeployment() {
      assert.deepStrictEqual(yield* apiProps, {});
    }),
  );

  it.effect("takes the properties of the deployment when infra provides it", () =>
    Effect.gen(function* withDeployment() {
      const props = yield* apiProps.pipe(
        Effect.provideService(ApiDeployment, { props: { name: "x" }, telemetry: {} }),
      );

      assert.deepStrictEqual(props, { name: "x" });
    }),
  );

  it.effect("takes the tracing options of the deployment, and none in the deployed bundle", () =>
    Effect.gen(function* tracing() {
      const planned = yield* apiTelemetry.pipe(
        Effect.provideService(ApiDeployment, { props: {}, telemetry: { headSamplingRate: 1 } }),
      );

      assert.deepStrictEqual(planned, { headSamplingRate: 1 });
      assert.deepStrictEqual(yield* apiTelemetry, {});
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
      const handler = yield* makeHandler(() => Effect.succeed(ada), notes, Layer.empty);

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
        notes,
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
