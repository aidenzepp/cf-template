import { Story } from "@alchemy.run/domain/Story";
import { Layer } from "effect";
import { CreateNote, DeleteNote, NotebookId, UpdateNote } from "./note.command.ts";
import { NoteCreated, NoteDeleted, NoteId, NoteUpdated } from "./note.event.ts";
import { NoteAlreadyExists, NoteNotFound, NoteQuotaExceeded } from "./note.rejection.ts";
import { NOTES_MAX_PER_OWNER, Notebook } from "./notebook.aggregate.ts";
import { NotesModel } from "./notes.model.ts";

/**
 * Runs a sequence of steps against the notes model in memory.
 */
const story = Story.make(NotesModel, { layer: Layer.empty });

/**
 * The notebook every story writes to.
 */
const notebook = Notebook.ref(NotebookId.make("owner-1"));

/**
 * The note id the stories create, update and delete.
 */
const n1 = NoteId.make("n-1");

/**
 * The note id no story creates.
 */
const missing = NoteId.make("n-missing");

/**
 * A create records the note, and a second create with the same id is refused.
 */
export const createsANote = story(
  Story.when(notebook, new CreateNote({ body: "Body", id: n1, title: "Title" })),
  Story.then(notebook, new NoteCreated({ body: "Body", id: n1, title: "Title" })),
  Story.when(notebook, new CreateNote({ body: "Other", id: n1, title: "Other" })),
  Story.rejected(new NoteAlreadyExists({ id: n1 })),
);

/**
 * A notebook at the per-owner limit refuses another create.
 */
export const refusesPastTheLimit = story(
  Story.given(
    notebook,
    ...Array.from(
      { length: NOTES_MAX_PER_OWNER },
      (_, index) => new NoteCreated({ body: "", id: NoteId.make(`n-${index}`), title: "" }),
    ),
  ),
  Story.when(notebook, new CreateNote({ body: "", id: NoteId.make("n-over"), title: "" })),
  Story.rejected(new NoteQuotaExceeded({ limit: NOTES_MAX_PER_OWNER })),
);

/**
 * An update records both values after it, records nothing when nothing changes, and refuses an
 * unknown note.
 */
export const updatesANote = story(
  Story.given(notebook, new NoteCreated({ body: "Body", id: n1, title: "Title" })),
  Story.when(notebook, new UpdateNote({ id: n1, title: "Renamed" })),
  Story.then(notebook, new NoteUpdated({ body: "Body", id: n1, title: "Renamed" })),
  Story.when(notebook, new UpdateNote({ body: "Body", id: n1 })),
  Story.then(notebook),
  Story.when(notebook, new UpdateNote({ id: missing, title: "Renamed" })),
  Story.rejected(new NoteNotFound({ id: missing })),
);

/**
 * A delete removes the note, and deleting it again is refused.
 */
export const deletesANote = story(
  Story.given(notebook, new NoteCreated({ body: "Body", id: n1, title: "Title" })),
  Story.when(notebook, new DeleteNote({ id: n1 })),
  Story.then(notebook, new NoteDeleted({ id: n1 })),
  Story.when(notebook, new DeleteNote({ id: n1 })),
  Story.rejected(new NoteNotFound({ id: n1 })),
);
