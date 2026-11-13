import * as Domain from "@alchemy.run/domain";
import { Record, Schema } from "effect";
import { CreateNote, DeleteNote, NotebookId, UpdateNote } from "./note.command.ts";
import { NoteCreated, NoteDeleted, NoteId, NoteUpdated } from "./note.event.ts";
import { NoteAlreadyExists, NoteNotFound, NoteQuotaExceeded } from "./note.rejection.ts";

/**
 * The most notes one owner may hold. `decide` refuses a create past it.
 */
export const NOTES_MAX_PER_OWNER = 100;

/**
 * One stored note; the times are the commit times of the events that set them.
 */
const NoteState = Schema.Struct({
  body: Schema.String,
  createdAt: Schema.DateTimeUtc,
  title: Schema.String,
  updatedAt: Schema.DateTimeUtc,
});

/**
 * The notes one owner holds, keyed by note id.
 */
const NotebookState = Schema.Struct({ notes: Schema.Record(NoteId, NoteState) });

/**
 * One owner's notes. One instance per owner is the single writer that keeps the per-owner limit.
 */
export class Notebook extends Domain.Aggregate("Notebook", {
  commands: [CreateNote, UpdateNote, DeleteNote],
  decide: {
    CreateNote: (s, cmd) => {
      if (Record.has(s.notes, cmd.id)) {
        return new NoteAlreadyExists({ id: cmd.id });
      }

      if (Record.size(s.notes) >= NOTES_MAX_PER_OWNER) {
        return new NoteQuotaExceeded({ limit: NOTES_MAX_PER_OWNER });
      }

      return [new NoteCreated({ body: cmd.body, id: cmd.id, title: cmd.title })];
    },
    DeleteNote: (s, cmd) =>
      Record.has(s.notes, cmd.id)
        ? [new NoteDeleted({ id: cmd.id })]
        : new NoteNotFound({ id: cmd.id }),
    UpdateNote: (s, cmd) => {
      const note = s.notes[cmd.id];

      if (note === undefined) {
        return new NoteNotFound({ id: cmd.id });
      }

      const title = cmd.title ?? note.title;
      const body = cmd.body ?? note.body;

      // An update that changes nothing records nothing.
      return title === note.title && body === note.body
        ? []
        : [new NoteUpdated({ body, id: cmd.id, title })];
    },
  },
  evolve: {
    NoteCreated: (s, e, env) => ({
      notes: Record.set(s.notes, e.id, {
        body: e.body,
        createdAt: env.at,
        title: e.title,
        updatedAt: env.at,
      }),
    }),
    NoteDeleted: (s, e) => ({ notes: Record.remove(s.notes, e.id) }),
    // decide already refused a missing note: keep the state an unknown id cannot follow
    NoteUpdated: (s, e, env) => {
      const note = s.notes[e.id];

      return note === undefined
        ? s
        : {
            notes: Record.set(s.notes, e.id, {
              ...note,
              body: e.body,
              title: e.title,
              updatedAt: env.at,
            }),
          };
    },
  },
  id: NotebookId,
  initial: { notes: {} },
  state: NotebookState,
}) {}
