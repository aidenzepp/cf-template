import { Schema } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { AuthUnavailable, SessionRequired } from "@workspace/contract/domain/auth-errors";
import { Note } from "@workspace/contract/domain/note";
import type { NoteId } from "@workspace/contract/domain/note";
import { NoteNotFound, NotesUnavailable } from "@workspace/contract/domain/note-errors";
import { ApiClient } from "../../api-client.ts";

/**
 * The reactivity key of the notes list: a mutation that adds, changes or removes a note names it,
 * and the list query re-reads once.
 */
export const NOTES_KEY = "notes";

/**
 * The reactivity key of one note's detail query. A mutation that changes the note names it; one
 * that removes the note does not, so the open page does not re-read a note that is gone before it
 * navigates away.
 *
 * @param id - The note.
 * @returns The key.
 */
export const noteKey = (id: typeof NoteId.Type) => `${NOTES_KEY}/${id}`;

/**
 * The list query of the signed-in caller's notes. It is serializable under `notes/list`, and
 * `skipInitialRun` keeps the value the loader dehydrated instead of fetching again on mount; a
 * mutation naming {@link NOTES_KEY} runs the request once.
 */
export const notesListAtom = ApiClient.query("notes", "list", { reactivityKeys: [NOTES_KEY] }).pipe(
  Atom.serializable({
    key: "notes/list",
    schema: AsyncResult.Schema({
      error: Schema.Union([AuthUnavailable, NotesUnavailable, SessionRequired]),
      success: Schema.Array(Note),
    }),
    skipInitialRun: true,
  }),
);

/**
 * The create mutation: a writable atom whose value is the result of the last call.
 */
export const createNoteAtom = ApiClient.mutation("notes", "create");

/**
 * The detail query of one note, one atom per id. It is serializable under `notes/<id>`, and
 * `skipInitialRun` keeps the value the loader dehydrated for that key instead of fetching again on
 * mount; a mutation naming {@link noteKey} of the note runs the request once.
 */
export const noteAtom = Atom.family((id: typeof NoteId.Type) =>
  ApiClient.query("notes", "get", { params: { id }, reactivityKeys: [noteKey(id)] }).pipe(
    Atom.serializable({
      key: `notes/${id}`,
      schema: AsyncResult.Schema({
        error: Schema.Union([AuthUnavailable, NoteNotFound, NotesUnavailable, SessionRequired]),
        success: Note,
      }),
      skipInitialRun: true,
    }),
  ),
);

/**
 * The update mutation: a writable atom whose value is the result of the last call.
 */
export const updateNoteAtom = ApiClient.mutation("notes", "update");

/**
 * The delete mutation: a writable atom whose value is the result of the last call.
 */
export const deleteNoteAtom = ApiClient.mutation("notes", "remove");
