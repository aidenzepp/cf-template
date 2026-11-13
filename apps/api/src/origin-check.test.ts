import * as Domain from "@alchemy.run/domain";
import { assert, describe, it } from "@effect/vitest";
import * as Http from "alchemy/Http";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { HttpApi, HttpApiBuilder } from "effect/http-api";
import { SessionLookup } from "./authorization.ts";
import { NotebookHttp } from "./docs/routes.ts";
import { NotesModel } from "./notes/notes.model.ts";
import { FOREIGN_ORIGIN_TYPE, OriginCheck } from "./origin-check.ts";
import { SessionLive } from "./session-middleware.ts";

/**
 * The origin the requests are addressed to, which `web` shares with the Api.
 */
const APP = "https://app.example.test";

/**
 * The read the tests call: a plain `GET` beside the Notebook group, which publishes commands only.
 */
const READ_PATH = "/api/probe";

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
        Layer.provide(NotesModel.layer(Layer.empty).pipe(Layer.provide(Domain.InMemory))),
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
 * A `GET` of the read route with the given `Origin`.
 *
 * @param origin - The `Origin` header.
 * @returns The request.
 */
const read = (origin: string) => new Request(`${APP}${READ_PATH}`, { headers: { origin } });

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
