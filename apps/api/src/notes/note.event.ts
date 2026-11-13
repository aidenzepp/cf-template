import * as Domain from "@alchemy.run/domain";
import { Schema } from "effect";

/**
 * Identifier of a note, chosen by the caller so a retried create names the same note.
 */
export const NoteId = Schema.String.pipe(Schema.brand("NoteId"));

/**
 * A note was created in its owner's notebook with this title and body.
 */
export class NoteCreated extends Domain.Event("NoteCreated", {
  body: Schema.String,
  id: NoteId,
  title: Schema.String,
}) {}

/**
 * A note's title and body changed; the event carries both values after the change.
 */
export class NoteUpdated extends Domain.Event("NoteUpdated", {
  body: Schema.String,
  id: NoteId,
  title: Schema.String,
}) {}

/**
 * A note was removed from its owner's notebook.
 */
export class NoteDeleted extends Domain.Event("NoteDeleted", { id: NoteId }) {}
