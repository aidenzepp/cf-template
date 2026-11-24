import { Effect, Layer } from "effect";
import { AppDatabase } from "../app-database.ts";
import { NoteIndexStore } from "./note-index.projection.ts";
import { noteIndex } from "./table.ts";
import type { NoteIndexRow } from "./table.ts";

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
