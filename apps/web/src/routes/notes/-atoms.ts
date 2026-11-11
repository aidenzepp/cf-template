import { Schema } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { AuthUnavailable, SessionRequired } from "@workspace/contract/domain/auth-errors";
import { Note } from "@workspace/contract/domain/note";
import type { NoteId } from "@workspace/contract/domain/note";
import { NoteNotFound, NotesUnavailable } from "@workspace/contract/domain/note-errors";
import { ApiClient } from "../../api-client.ts";

/**
 * The list query of the signed-in caller's notes. It is serializable under `notes/list`, and
 * `skipInitialRun` keeps the value the loader dehydrated instead of fetching again on mount; a
 * refresh runs the request once.
 */
export const notesListAtom = ApiClient.query("notes", "list", {}).pipe(
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
 * mount.
 */
export const noteAtom = Atom.family((id: typeof NoteId.Type) =>
  ApiClient.query("notes", "get", { params: { id } }).pipe(
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
