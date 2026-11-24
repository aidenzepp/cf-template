import { Context, Effect, Layer } from "effect";
import { AppDatabase } from "../app-database.ts";
import { noteIndex } from "./table.ts";
import type { NoteIndexRow } from "./table.ts";

/**
 * The store the note index writes to. `upsert` writes the row keyed by its `stream` and `seq`,
 * replacing a row already there, so writing one row twice leaves one row.
 */
export class NoteIndexStore extends Context.Service<
  NoteIndexStore,
  { readonly upsert: (row: NoteIndexRow) => Effect.Effect<void> }
>()("@workspace/api/NoteIndexStore") {}

/**
 * The note index store over the app D1 database: one insert per row, which updates the row a
 * redelivered event already wrote. A failed query is a defect, so the run is retried.
 */
export const NoteIndexStoreD1 = Layer.effect(
  NoteIndexStore,
  Effect.gen(function* buildNoteIndexStoreD1() {
    const database = yield* AppDatabase;

    return {
      upsert: Effect.fn("NoteIndexStore.upsert")(function* upsertNoteIndexRow(row: NoteIndexRow) {
        const { db } = yield* database;

        yield* db
          .insert(noteIndex)
          .values(row)
          .onConflictDoUpdate({ set: row, target: [noteIndex.stream, noteIndex.seq] });
      }, Effect.orDie),
    };
  }),
);
