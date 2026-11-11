import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import { Note, NoteCreate, NoteId, NotePatch } from "../domain/note.ts";
import { NoteNotFound, NoteQuotaExceeded } from "../domain/note-errors.ts";
import { ExampleFeatureGate, SessionMiddleware } from "./authorization.ts";

/**
 * The notes endpoints under `/api`. The gate is declared before the session middleware, so the
 * session middleware runs first and an anonymous caller gets 401 whether the feature is on or off.
 */
export const NotesApiGroup = HttpApiGroup.make("notes")
  .add(
    HttpApiEndpoint.get("list", "/notes", { success: Schema.Array(Note) }),
    HttpApiEndpoint.post("create", "/notes", {
      error: NoteQuotaExceeded,
      payload: NoteCreate,
      success: Note.pipe(HttpApiSchema.status(201)),
    }),
    HttpApiEndpoint.get("get", "/notes/:id", {
      error: NoteNotFound,
      params: { id: NoteId },
      success: Note,
    }),
    HttpApiEndpoint.patch("update", "/notes/:id", {
      error: NoteNotFound,
      params: { id: NoteId },
      payload: NotePatch,
      success: Note,
    }),
    HttpApiEndpoint.delete("remove", "/notes/:id", {
      error: NoteNotFound,
      params: { id: NoteId },
      success: HttpApiSchema.NoContent,
    }),
  )
  .middleware(ExampleFeatureGate)
  .middleware(SessionMiddleware)
  .prefix("/api");
