import * as Domain from "@alchemy.run/domain";
import { NoteIndex } from "./note-index.projection.ts";
import { Note } from "./note.view.ts";
import { Notebook } from "./notebook.aggregate.ts";

/**
 * The notes model: one `Notebook` per owner, the `Note` view that reads one note, and the
 * `NoteIndex` projection of its events.
 */
export class NotesModel extends Domain.Model("Notes", {
  aggregates: [Notebook],
  projections: [NoteIndex],
  views: [Note],
}) {}
