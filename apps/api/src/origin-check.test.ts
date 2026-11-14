import * as Domain from "@alchemy.run/domain";
import { assert, describe, it } from "@effect/vitest";
import * as Http from "alchemy/Http";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { HttpApi, HttpApiBuilder } from "effect/http-api";
import { SessionLookup } from "./authorization.ts";
import { NotebookHttp } from "./docs/routes.ts";
import { NoteIndexUnstored } from "./notes/note-index.projection.ts";
import { NotesModel } from "./notes/notes.model.ts";
import { FOREIGN_ORIGIN_TYPE, OriginCheck } from "./origin-check.ts";
import { SessionLive } from "./session-middleware.ts";

/**
 * The origin the requests are addressed to, which `web` shares with the Api.
 */
const APP = "https://app.example.test";

/**
 * A plain `GET` route beside the Notebook group, which the check must guard like the group's own.
 */
const READ_PATH = "/api/probe";

/**
 * The Notebook group's read of one note, `GET /api/Note/{key}`, for note `n-1` of `owner-1`.
 */
const NOTE_PATH = "/api/Note/owner-1~n-1";

/**
 * The Notebook group's live read of the same note, served as Server-Sent Events.
 */
const NOTE_WATCH_PATH = `${NOTE_PATH}/watch`;

/**
 * The Notebook group under `/api`, as the Worker serves it.
 */
const Hosted = HttpApi.make("Hosted").add(NotebookHttp.group.prefix("/api"));

/**
 * The router under test: the Notebook group hosted in memory with the real `Session` middleware
 * over a lookup that finds no session, one read route, and the Origin check.
 */
const routes = Layer.mergeAll(
  HttpApiBuilder.layer(Hosted).pipe(
    Layer.provide(
      NotebookHttp.layerFor(Hosted).pipe(
        Layer.provide(SessionLive),
        Layer.provide(NotesModel.layer(NoteIndexUnstored).pipe(Layer.provide(Domain.InMemory))),
        Layer.provide(
          Layer.succeed(SessionLookup, SessionLookup.of({ current: Effect.succeed(null) })),
        ),
      ),
    ),
    Layer.provide(Http.Platform),
  ),
  HttpRouter.add("GET", READ_PATH, HttpServerResponse.text("read")),
  OriginCheck,
);

/**
 * The status and body of one request to the router.
 *
 * @param request - The request to send.
 * @returns A scoped effect of the answer.
 */
const send = (request: Request) =>
  Effect.acquireRelease(
    Effect.sync(() => HttpRouter.toWebHandler(routes, { disableLogger: true })),
    ({ dispose }) => Effect.promise(dispose),
  ).pipe(
    Effect.flatMap(({ handler }) => Effect.promise(() => handler(request))),
    Effect.flatMap((response) =>
      Effect.promise(() => response.text()).pipe(
        Effect.map((body) => ({ body, status: response.status })),
      ),
    ),
  );

/**
 * A `POST /api/CreateNote` command with the given `Origin`, or none.
 *
 * @param origin - The `Origin` header, or `undefined` to send none.
 * @returns The request.
 */
const command = (origin: string | undefined) => {
  const headers = new Headers({ "content-type": "application/json" });

  if (origin !== undefined) {
    headers.set("origin", origin);
  }

  return new Request(`${APP}/api/CreateNote`, {
    body: JSON.stringify({
      commandId: "c-1",
      input: { body: "", id: "n-1", title: "Title" },
      target: "owner-1",
    }),
    headers,
    method: "POST",
  });
};

/**
 * A `GET` of a read route with the given `Origin`.
 *
 * @param origin - The `Origin` header.
 * @param path - The path to read: the plain read route unless given.
 * @returns The request.
 */
const read = (origin: string, path = READ_PATH) =>
  new Request(`${APP}${path}`, { headers: { origin } });

describe("the Origin check", () => {
  it.effect("refuses a command from a foreign origin before it is routed", () =>
    Effect.gen(function* foreignCommand() {
      const answer = yield* send(command("https://evil.example.test"));

      assert.strictEqual(answer.status, 403);
      assert.include(answer.body, FOREIGN_ORIGIN_TYPE);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a read from a foreign origin", () =>
    Effect.gen(function* foreignRead() {
      const answer = yield* send(read("https://evil.example.test"));

      assert.strictEqual(answer.status, 403);
      assert.include(answer.body, FOREIGN_ORIGIN_TYPE);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a note read and a note watch from a foreign origin", () =>
    Effect.gen(function* foreignNoteRead() {
      for (const path of [NOTE_PATH, NOTE_WATCH_PATH]) {
        const answer = yield* send(read("https://evil.example.test", path));

        assert.strictEqual(answer.status, 403, path);
        assert.include(answer.body, FOREIGN_ORIGIN_TYPE, path);
      }
    }).pipe(Effect.scoped),
  );

  it.effect("passes a same-origin note read on to the Notebook group", () =>
    Effect.gen(function* sameOriginNoteRead() {
      // No session: the view's own middleware answers, so the check let the read through.
      const answer = yield* send(read(APP, NOTE_PATH));

      assert.strictEqual(answer.status, 401);
      assert.include(answer.body, "/problems/session-required");
    }).pipe(Effect.scoped),
  );

  it.effect("refuses an opaque null origin", () =>
    Effect.gen(function* nullOrigin() {
      const answer = yield* send(read("null"));

      assert.strictEqual(answer.status, 403);
    }).pipe(Effect.scoped),
  );

  it.effect("passes a same-origin command on to the Notebook group", () =>
    Effect.gen(function* sameOriginCommand() {
      // No session: the group's own middleware answers, so the check let the command through.
      const answer = yield* send(command(APP));

      assert.strictEqual(answer.status, 401);
      assert.include(answer.body, "/problems/session-required");
    }).pipe(Effect.scoped),
  );

  it.effect("passes a same-origin read", () =>
    Effect.gen(function* sameOriginRead() {
      const answer = yield* send(read(APP));

      assert.strictEqual(answer.status, 200);
      assert.strictEqual(answer.body, "read");
    }).pipe(Effect.scoped),
  );

  it.effect("passes a command that names no origin", () =>
    Effect.gen(function* noOrigin() {
      const answer = yield* send(command(undefined));

      assert.strictEqual(answer.status, 401);
    }).pipe(Effect.scoped),
  );
});
