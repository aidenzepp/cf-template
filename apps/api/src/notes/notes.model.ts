import * as Domain from "@alchemy.run/domain";
import { NoteIndex } from "./note-index.projection.ts";
import { Notebook } from "./notebook.aggregate.ts";

/**
 * The notes model: one `Notebook` per owner, and the `NoteIndex` projection of its events.
 */
export class NotesModel extends Domain.Model("Notes", {
  aggregates: [Notebook],
  projections: [NoteIndex],
}) {}
