import * as Domain from "@alchemy.run/domain";
import { assert, describe, it } from "@effect/vitest";
import { DateTime, Effect, Exit, Layer } from "effect";
import { HttpServerRequest } from "effect/http";
import { Session, UserId } from "@workspace/contract/domain/session";
import { SessionLookup } from "../authorization.ts";
import { SessionLive } from "../session-middleware.ts";
import { NOTE_TITLE_MAX_LENGTH, NotebookId } from "./note.command.ts";
import { NoteId } from "./note.event.ts";
import { NotebookApi } from "./notebook.api.ts";
import { NoteIndexUnstored } from "./note-index.projection.ts";
import { NotesModel } from "./notes.model.ts";

/**
 * A lookup that reads the `Cookie` header: `sid=<user>` is that user signed in, no cookie is
 * signed out.
 */
const lookup = Layer.succeed(
  SessionLookup,
  SessionLookup.of({
    current: Effect.gen(function* current() {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const cookie = request.headers.cookie ?? "";

      return cookie.startsWith("sid=")
        ? new Session({
            email: "user@example.test",
            expiresAt: DateTime.makeUnsafe("2030-01-01T00:00:00Z"),
            image: null,
            name: "User",
            userId: UserId.make(cookie.slice("sid=".length)),
          })
        : null;
    }),
  }),
);

/**
 * The notes model hosted in memory with the real `Session` middleware over the stub lookup.
 */
const World = Layer.mergeAll(
  NotesModel.layer(NoteIndexUnstored).pipe(Layer.provide(Domain.InMemory)),
  SessionLive.pipe(Layer.provide(lookup)),
);

/**
 * The notebook of `owner-1`, the notebook the tests write to.
 */
const notebook = NotebookId.make("owner-1");

/**
 * The note id the tests create.
 */
const n1 = NoteId.make("n-1");

/**
 * The headers of a call signed in as the given user.
 *
 * @param user - The user id the session belongs to.
 * @returns The call options carrying that user's cookie.
 */
const as = (user: string) => ({ headers: { cookie: `sid=${user}` } });

describe("the Notebook Api", () => {
  it.effect("refuses a command with no session", () =>
    Effect.gen(function* refusesAnonymous() {
      const api = yield* NotebookApi.clientInProcess;

      const refused = yield* Effect.flip(
        api.CreateNote(notebook, { body: "", id: n1, title: "Title" }),
      );

      assert.strictEqual(refused._tag, "SessionRequired");
    }).pipe(Effect.scoped, Effect.provide(World)),
  );

  it.effect("refuses another user's command on the owner's notebook and records nothing", () =>
    Effect.gen(function* refusesStranger() {
      const api = yield* NotebookApi.clientInProcess;

      const refused = yield* Effect.flip(
        api.CreateNote(notebook, { body: "", id: n1, title: "Title" }, as("owner-2")),
      );

      assert.strictEqual(refused._tag, "NotNotebookOwner");

      // The refused create recorded nothing, so the owner's first create is version 1.
      const created = yield* api.CreateNote(
        notebook,
        { body: "", id: n1, title: "Title" },
        as("owner-1"),
      );

      assert.strictEqual(created.version, 1);
    }).pipe(Effect.scoped, Effect.provide(World)),
  );

  it.effect("rejects a command its schema refuses before the aggregate runs", () =>
    Effect.gen(function* rejectsBadCommand() {
      const api = yield* NotebookApi.clientInProcess;
      const tooLong = "x".repeat(NOTE_TITLE_MAX_LENGTH + 1);

      const refused = yield* Effect.exit(
        api.CreateNote(notebook, { body: "", id: n1, title: tooLong }, as("owner-1")),
      );

      assert.isTrue(Exit.isFailure(refused));

      // The refused create recorded nothing, so the same id is still free.
      const created = yield* api.CreateNote(
        notebook,
        { body: "", id: n1, title: "Title" },
        as("owner-1"),
      );

      assert.strictEqual(created.version, 1);
    }).pipe(Effect.scoped, Effect.provide(World)),
  );
});
