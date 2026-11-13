import * as Domain from "@alchemy.run/domain";
import { Notebook } from "./notebook.aggregate.ts";

/**
 * The notes model: one `Notebook` per owner.
 */
export class NotesModel extends Domain.Model("Notes", { aggregates: [Notebook] }) {}
