import * as Domain from "@alchemy.run/domain";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Ref } from "effect";
import { UserId } from "@workspace/contract/domain/session";
import { CurrentActor } from "../session-middleware.ts";
import { CreateNote, DeleteNote, NotebookId, UpdateNote } from "./note.command.ts";
import { NoteId } from "./note.event.ts";
import { NoteIndex, NoteIndexStore, noteIndexHandler } from "./note-index.projection.ts";
import type { NoteIndexInput } from "./note-index.projection.ts";
import { Notebook } from "./notebook.aggregate.ts";
import { NotesModel } from "./notes.model.ts";
import type { NoteIndexRow } from "./table.ts";

/**
 * A note index store in memory, keyed like the D1 table by `stream` and `seq`.
 *
 * @returns The store's layer and its rows, sorted by key.
 */
const memoryStore = Effect.gen(function* makeMemoryStore() {
  const rows = yield* Ref.make(new Map<string, NoteIndexRow>());

  return {
    layer: Layer.succeed(NoteIndexStore, {
      upsert: (row) => Ref.update(rows, (map) => new Map(map).set(`${row.stream}#${row.seq}`, row)),
    }),
    rows: Ref.get(rows).pipe(
      Effect.map((map) => [...map.entries()].toSorted(([a], [b]) => a.localeCompare(b))),
    ),
  };
});

/**
 * Run the notes model in memory, create, update and delete one note, and wait for the note index.
 *
 * @returns The inputs the platform delivered to the projection and the rows it wrote.
 */
const hostedRun = Effect.gen(function* runHosted() {
  const store = yield* memoryStore;
  const delivered = yield* Ref.make<ReadonlyArray<NoteIndexInput>>([]);

  const recording = NoteIndex.toLayer(
    noteIndexHandler.pipe(
      Effect.map(
        (handle) => (batch: ReadonlyArray<NoteIndexInput>) =>
          Ref.update(delivered, (inputs) => [...inputs, ...batch]).pipe(
            Effect.andThen(handle(batch)),
          ),
      ),
    ),
  ).pipe(Layer.provide(store.layer));

  yield* Effect.gen(function* sendCommands() {
    const notebooks = yield* Notebook;
    const id = NotebookId.make("owner-1");
    const note = NoteId.make("n-1");

    yield* notebooks.send(id, new CreateNote({ body: "Body", id: note, title: "Title" }));
    yield* notebooks.send(id, new UpdateNote({ body: "Other", id: note, title: "Other" }));

    const receipt = yield* notebooks.send(id, new DeleteNote({ id: note }));

    yield* NoteIndex.caughtUp(receipt);
  }).pipe(
    Effect.provideService(CurrentActor, { userId: UserId.make("owner-1") }),
    Effect.provide(NotesModel.layer(recording).pipe(Layer.provide(Domain.InMemory))),
  );

  return { inputs: yield* Ref.get(delivered), rows: yield* store.rows };
});

/**
 * Write inputs through the note index handler into a store.
 *
 * @param layer - The store's layer.
 * @param inputs - The inputs, in delivery order.
 * @returns An effect that handles them.
 */
const replay = (layer: Layer.Layer<NoteIndexStore>, inputs: ReadonlyArray<NoteIndexInput>) =>
  noteIndexHandler.pipe(
    Effect.flatMap((handle) => handle(inputs)),
    Effect.provide(layer),
  );

// The in-memory platform delivers to projections on the real clock, so these run with `it.live`.
describe("the note index", () => {
  it.live("writes one row per event, keyed by stream and seq", () =>
    Effect.gen(function* writesOneRowPerEvent() {
      const { rows } = yield* hostedRun;

      expect(rows.map(([, row]) => [row.seq, row.kind, row.noteId, row.notebookId])).toStrictEqual([
        [1, "NoteCreated", "n-1", "owner-1"],
        [2, "NoteUpdated", "n-1", "owner-1"],
        [3, "NoteDeleted", "n-1", "owner-1"],
      ]);
    }),
  );

  it.live("leaves the same rows when every event is delivered again", () =>
    Effect.gen(function* redeliversEveryEvent() {
      const { inputs } = yield* hostedRun;
      const store = yield* memoryStore;

      yield* replay(store.layer, inputs);

      const once = yield* store.rows;

      yield* replay(store.layer, inputs);
      yield* replay(store.layer, inputs.toReversed());

      expect(yield* store.rows).toStrictEqual(once);
    }),
  );

  it.live("rebuilds the same rows from the whole history into an empty store", () =>
    Effect.gen(function* rebuildsFromHistory() {
      const { inputs, rows } = yield* hostedRun;
      const rebuilt = yield* memoryStore;

      yield* replay(rebuilt.layer, inputs);

      expect(yield* rebuilt.rows).toStrictEqual(rows);
    }),
  );
});
