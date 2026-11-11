import { Schema } from "effect";

/**
 * Identifier of a note.
 */
export const NoteId = Schema.String.pipe(Schema.brand("NoteId"));

/**
 * A stored note as the API returns it.
 */
export class Note extends Schema.Class<Note>("Note")({
  body: Schema.String,
  createdAt: Schema.DateTimeUtcFromString,
  id: NoteId,
  title: Schema.String,
  updatedAt: Schema.DateTimeUtcFromString,
}) {}

/**
 * Request body for creating a note.
 */
export class NoteCreate extends Schema.Class<NoteCreate>("NoteCreate")({
  body: Schema.String,
  title: Schema.String,
}) {}

/**
 * Request body for updating a note; omitted fields stay unchanged.
 */
export class NotePatch extends Schema.Class<NotePatch>("NotePatch")({
  body: Schema.optionalKey(Schema.String),
  title: Schema.optionalKey(Schema.String),
}) {}
