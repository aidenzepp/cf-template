import * as Domain from "@alchemy.run/domain";
import { Console, Context, DateTime, Effect, Layer } from "effect";
import { AppDatabase } from "../app-database.ts";
import { NoteCreated, NoteDeleted, NoteUpdated } from "./note.event.ts";
import { Notebook } from "./notebook.aggregate.ts";
import { noteIndex } from "./table.ts";
import type { NoteIndexRow } from "./table.ts";

/**
 * Indexes every notebook event into the app D1 database, one row per event.
 */
export class NoteIndex extends Domain.Projection("NoteIndex", {
  from: [Notebook],
  key: Notebook,
  on: [NoteCreated, NoteUpdated, NoteDeleted],
}) {}

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

/**
 * One input of the note index: a notebook event with its envelope.
 */
export type NoteIndexInput = Domain.Projection.Input<
  typeof Notebook,
  typeof Notebook,
  NoteCreated | NoteUpdated | NoteDeleted
>;

/**
 * The row one input writes: its event's place in the stream, the notebook, the note and the
 * event's tag.
 *
 * @param input - One input of the projection.
 * @returns The row keyed by the input's `stream` and `seq`.
 */
const noteIndexRow = (input: NoteIndexInput): NoteIndexRow => ({
  at: DateTime.toEpochMillis(input.envelope.at),
  kind: input.event._tag,
  noteId: input.event.id,
  notebookId: input.envelope.id,
  seq: input.envelope.seq,
  stream: input.envelope.stream,
});

/**
 * The one `domain.run.failed` line a failed run of the note index writes through `Console.error`,
 * as one JSON text so Workers Logs reads its keys at the top level of `attributes`. The package
 * records the failure only as its `domain.runs` metric, which never reaches Workers Logs; this line
 * is what the `infra` projection failure alert counts.
 */
const failedRunLine =
  '{"consumer":"NoteIndex","event":"domain.run.failed","kind":"projection","outcome":"failed"}';

/**
 * Build the note index's handler over {@link NoteIndexStore}: each input upserts its row, in
 * order, so running a batch again, or the whole history into an empty store, writes the same rows.
 * A failed run writes one {@link failedRunLine} and keeps its cause, so the platform still records
 * and retries it.
 */
export const noteIndexHandler = Effect.gen(function* buildNoteIndexHandler() {
  const store = yield* NoteIndexStore;

  return (batch: ReadonlyArray<NoteIndexInput>) =>
    Effect.forEach(batch, (input) => store.upsert(noteIndexRow(input)), { discard: true }).pipe(
      Effect.tapCause(() => Console.error(failedRunLine)),
    );
});

/**
 * The note index's implementation: {@link noteIndexHandler}, one input at a time.
 */
export const NoteIndexLive = NoteIndex.toLayer(noteIndexHandler);

/**
 * The note index writing nowhere, for a host that runs the notes model and never reads the index,
 * such as a test of the commands.
 */
export const NoteIndexUnstored = NoteIndexLive.pipe(
  Layer.provide(Layer.succeed(NoteIndexStore, { upsert: () => Effect.void })),
);
