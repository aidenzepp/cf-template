import * as Domain from "@alchemy.run/domain";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, Layer } from "effect";
import { NOTE_TITLE_MAX_LENGTH, NotebookId } from "./note.command.ts";
import { NoteId } from "./note.event.ts";
import { NotebookApi } from "./notebook.api.ts";
import { NotesModel } from "./notes.model.ts";

/**
 * The notes model hosted in memory, as the Api serves it.
 */
const World = NotesModel.layer(Layer.empty).pipe(Layer.provide(Domain.InMemory));

/**
 * The notebook the test writes to.
 */
const notebook = NotebookId.make("owner-1");

/**
 * The note id the test creates.
 */
const n1 = NoteId.make("n-1");

describe("the Notebook Api", () => {
  it.effect("rejects a command its schema refuses before the aggregate runs", () =>
    Effect.gen(function* rejectsBadCommand() {
      const api = yield* NotebookApi.clientInProcess;
      const tooLong = "x".repeat(NOTE_TITLE_MAX_LENGTH + 1);

      const refused = yield* Effect.exit(
        api.CreateNote(notebook, { body: "", id: n1, title: tooLong }),
      );

      assert.isTrue(Exit.isFailure(refused));

      // The refused create recorded nothing, so the same id is still free.
      const created = yield* api.CreateNote(notebook, { body: "", id: n1, title: "Title" });

      assert.strictEqual(created.version, 1);
    }).pipe(Effect.scoped, Effect.provide(World)),
  );
});
