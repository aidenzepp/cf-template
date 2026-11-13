import * as Domain from "@alchemy.run/domain";
import { Schema } from "effect";
import { NoteCreated, NoteDeleted, NoteId, NoteUpdated } from "./note.event.ts";
import { NoteAlreadyExists, NoteNotFound, NoteQuotaExceeded } from "./note.rejection.ts";

/**
 * Identifier of a notebook: the id of the owner whose notes it holds.
 */
export const NotebookId = Schema.String.pipe(Schema.brand("NotebookId"));

/**
 * The most characters a note title may hold.
 */
export const NOTE_TITLE_MAX_LENGTH = 200;

/**
 * The most characters a note body may hold.
 */
export const NOTE_BODY_MAX_LENGTH = 10_000;

/**
 * The title a command may set, at most {@link NOTE_TITLE_MAX_LENGTH} characters.
 */
const NoteTitle = Schema.String.check(Schema.isMaxLength(NOTE_TITLE_MAX_LENGTH));

/**
 * The body a command may set, at most {@link NOTE_BODY_MAX_LENGTH} characters.
 */
const NoteBody = Schema.String.check(Schema.isMaxLength(NOTE_BODY_MAX_LENGTH));

/**
 * Add a note to the owner's notebook, within the per-owner limit.
 */
export class CreateNote extends Domain.Command("CreateNote", {
  events: [NoteCreated],
  input: { body: NoteBody, id: NoteId, title: NoteTitle },
  rejects: [NoteAlreadyExists, NoteQuotaExceeded],
  target: NotebookId,
}) {}

/**
 * Change a note's title, body or both; an omitted field keeps its value.
 */
export class UpdateNote extends Domain.Command("UpdateNote", {
  events: [NoteUpdated],
  input: { body: Schema.optionalKey(NoteBody), id: NoteId, title: Schema.optionalKey(NoteTitle) },
  rejects: [NoteNotFound],
  target: NotebookId,
}) {}

/**
 * Remove a note from the owner's notebook.
 */
export class DeleteNote extends Domain.Command("DeleteNote", {
  events: [NoteDeleted],
  input: { id: NoteId },
  rejects: [NoteNotFound],
  target: NotebookId,
}) {}
