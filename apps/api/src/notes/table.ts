import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * The note index: one row per notebook event, written by the `NoteIndex` projection. The key is
 * the event's place in its stream (`stream`, `seq`), so a redelivered or replayed event writes the
 * same row. `notebook_id` is the owner's opaque identifier from the auth database, so there is no
 * foreign key. `at` is the commit time in Unix milliseconds.
 */
export const noteIndex = sqliteTable(
  "note_index",
  {
    at: integer("at").notNull(),
    kind: text("kind").notNull(),
    notebookId: text("notebook_id").notNull(),
    noteId: text("note_id").notNull(),
    seq: integer("seq").notNull(),
    stream: text("stream").notNull(),
  },
  (table) => [primaryKey({ columns: [table.stream, table.seq] })],
);

/**
 * One row of {@link noteIndex}.
 */
export type NoteIndexRow = typeof noteIndex.$inferInsert;
