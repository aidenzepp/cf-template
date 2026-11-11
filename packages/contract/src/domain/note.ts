import { Schema } from "effect";

/**
 * Identifier of a note.
 */
export const NoteId = Schema.String.pipe(Schema.brand("NoteId"));

/**
 * The most characters a note title may hold.
 */
export const NOTE_TITLE_MAX_LENGTH = 200;

/**
 * The most characters a note body may hold.
 */
export const NOTE_BODY_MAX_LENGTH = 10_000;

/**
 * The title of a note, at most {@link NOTE_TITLE_MAX_LENGTH} characters.
 */
export const NoteTitle = Schema.String.check(Schema.isMaxLength(NOTE_TITLE_MAX_LENGTH));

/**
 * The body of a note, at most {@link NOTE_BODY_MAX_LENGTH} characters.
 */
export const NoteBody = Schema.String.check(Schema.isMaxLength(NOTE_BODY_MAX_LENGTH));

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
  body: NoteBody,
  title: NoteTitle,
}) {}

/**
 * Request body for updating a note; omitted fields stay unchanged.
 */
export class NotePatch extends Schema.Class<NotePatch>("NotePatch")({
  body: Schema.optionalKey(NoteBody),
  title: Schema.optionalKey(NoteTitle),
}) {}
