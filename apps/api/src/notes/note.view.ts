import * as Domain from "@alchemy.run/domain";
import { Effect, Schema } from "effect";
import { Session } from "../session-middleware.ts";
import { NotebookId } from "./note.command.ts";
import { NoteId } from "./note.event.ts";
import { NotNotebookOwner, NoteNotFound } from "./note.rejection.ts";
import { Notebook, mustOwn } from "./notebook.aggregate.ts";

/**
 * The character that joins a notebook id and a note id in a {@link NoteKey}. It needs no escaping in
 * a URL path segment, and a notebook id (a user id) never holds it, so the first one in a key ends
 * the notebook id.
 */
const NOTE_KEY_SEPARATOR = "~";

/**
 * Key of one note in the {@link Note} view: `<notebook id>~<note id>`, one path segment. A note id
 * is unique only within its notebook, so the key names both.
 */
const NoteKey = Schema.String.pipe(Schema.brand("NoteKey"));

/**
 * The {@link NoteKey} of one note.
 *
 * @param notebook - The id of the notebook that holds the note.
 * @param note - The note's id within that notebook.
 * @returns The key the {@link Note} view reads the note under.
 */
export const noteKey = (notebook: string, note: string) =>
  NoteKey.make(`${notebook}${NOTE_KEY_SEPARATOR}${note}`);

/**
 * Split a {@link NoteKey} at its first separator. A key with no separator names a notebook and an
 * empty note id, which no note has.
 *
 * @param key - The key a read names.
 * @returns The notebook id and the note id the key names.
 */
const partsOf = (key: typeof NoteKey.Type) => {
  const at = key.indexOf(NOTE_KEY_SEPARATOR);

  return at === -1
    ? { id: NoteId.make(""), notebook: NotebookId.make(key) }
    : { id: NoteId.make(key.slice(at + 1)), notebook: NotebookId.make(key.slice(0, at)) };
};

/**
 * One note as its owner reads it; the times are the commit times of the events that set them.
 */
const NoteRead = Schema.Struct({
  body: Schema.String,
  createdAt: Schema.DateTimeUtc,
  title: Schema.String,
  updatedAt: Schema.DateTimeUtc,
});

/**
 * One note, read by its owner as `GET /api/Note/{key}`. A reader who does not own the notebook is
 * refused with `NotNotebookOwner`, and a note that does not exist or was deleted with
 * `NoteNotFound`; the owner check runs first, so a stranger learns nothing about which notes exist.
 */
export class Note extends Domain.View("Note", {
  evolve: {
    NoteCreated: (_note, e, { at }) => ({
      body: e.body,
      createdAt: at,
      title: e.title,
      updatedAt: at,
    }),
    // Deleting the key makes a later read answer NoteNotFound.
    NoteDeleted: () => null,
    NoteUpdated: (note, e, { at }) =>
      note === null ? null : { ...note, body: e.body, title: e.title, updatedAt: at },
  },
  from: [Notebook],
  initial: null,
  key: NoteKey,
  keyOf: { Notebook: ({ event, source }) => noteKey(source.id, event.id) },
  middleware: [Session],
  rejects: [NotNotebookOwner, NoteNotFound],
  state: Schema.NullOr(NoteRead),
  validate: (request, note) => {
    const { id, notebook } = partsOf(request.key);

    return mustOwn(notebook).pipe(
      Effect.andThen(note === null ? Effect.fail(new NoteNotFound({ id })) : Effect.void),
    );
  },
}) {}
