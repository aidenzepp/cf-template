import * as Domain from "@alchemy.run/domain";
import { NotesModel } from "./notes.model.ts";

/**
 * The notes Api: every Notebook command. Each command is guarded by the `Session` middleware its
 * own declaration lists.
 */
export class NotebookApi extends Domain.Api("NotebookApi", {
  commands: ["CreateNote", "UpdateNote", "DeleteNote"],
  model: NotesModel,
}) {}
