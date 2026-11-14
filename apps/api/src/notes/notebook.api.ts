import * as Domain from "@alchemy.run/domain";
import { NotesModel } from "./notes.model.ts";

/**
 * The notes Api: every Notebook command and the `Note` view, each guarded by the `Session`
 * middleware its declaration lists, so only a signed-in owner may write or read its own notebook.
 */
export class NotebookApi extends Domain.Api("NotebookApi", {
  commands: ["CreateNote", "UpdateNote", "DeleteNote"],
  model: NotesModel,
  views: ["Note"],
}) {}
