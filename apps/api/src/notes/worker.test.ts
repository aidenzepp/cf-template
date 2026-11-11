import * as Cloudflare from "@alchemy.run/cloudflare";
import { assert, describe, it } from "@effect/vitest";
import { Context, DateTime, Effect, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { Session, UserId } from "@workspace/contract/domain/session";
import { makeHandler } from "../worker.ts";
import { Notes } from "./notes.ts";
import type { NotesService } from "./notes.ts";

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
      const handler = yield* makeHandler(() => Effect.succeed(ada), Context.make(Notes, notes));

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
});
