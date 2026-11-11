import { Schema } from "effect";
import { HttpApiError } from "effect/http-api";
import { NoteId } from "./note.ts";

/**
 * No note has the requested id.
 */
export class NoteNotFound extends HttpApiError.Problem<NoteNotFound>()(
  "NoteNotFound",
  { status: 404, title: "Note not found", type: "/problems/note-not-found" },
  { id: NoteId },
) {}

/**
 * The caller already holds the maximum number of notes.
 */
export class NoteQuotaExceeded extends HttpApiError.Problem<NoteQuotaExceeded>()(
  "NoteQuotaExceeded",
  { status: 409, title: "Note quota exceeded", type: "/problems/note-quota-exceeded" },
  { limit: Schema.Int },
) {}

/**
 * The example notes feature is switched off.
 */
export class NotesUnavailable extends HttpApiError.Problem<NotesUnavailable>()("NotesUnavailable", {
  status: 404,
  title: "Notes are not available",
  type: "/problems/notes-unavailable",
}) {}
