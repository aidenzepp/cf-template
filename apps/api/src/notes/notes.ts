import { Context, DateTime, Effect, Layer, Random, Ref } from "effect";
import type { UserId } from "@workspace/contract/domain/session";
import { Note, NoteId } from "@workspace/contract/domain/note";
import type { NoteCreate, NotePatch } from "@workspace/contract/domain/note";
import { NoteNotFound, NoteQuotaExceeded } from "@workspace/contract/domain/note-errors";
import { NOTES_MAX_PER_OWNER } from "./table.ts";

/**
 * The identifier of a note owner, the `userId` of a session.
 */
type OwnerId = typeof UserId.Type;

/**
 * The identifier of a note.
 */
type NoteIdType = typeof NoteId.Type;

/**
 * The operations on notes. Every operation is scoped to the owner it names: a note of another owner
 * is `NoteNotFound`, never a different failure, so a caller cannot probe for foreign ids.
 */
export interface NotesService {
  /**
   * List the owner's notes, newest first.
   */
  readonly list: (owner: OwnerId) => Effect.Effect<readonly Note[]>;
  /**
   * Store a new note, failing with `NoteQuotaExceeded` when the owner already holds
   * {@link NOTES_MAX_PER_OWNER}.
   */
  readonly create: (owner: OwnerId, input: NoteCreate) => Effect.Effect<Note, NoteQuotaExceeded>;
  /**
   * Read one of the owner's notes.
   */
  readonly get: (owner: OwnerId, id: NoteIdType) => Effect.Effect<Note, NoteNotFound>;
  /**
   * Change the fields `patch` names on one of the owner's notes.
   */
  readonly update: (
    owner: OwnerId,
    id: NoteIdType,
    patch: NotePatch,
  ) => Effect.Effect<Note, NoteNotFound>;
  /**
   * Delete one of the owner's notes.
   */
  readonly remove: (owner: OwnerId, id: NoteIdType) => Effect.Effect<void, NoteNotFound>;
}

/**
 * The service behind the notes endpoints.
 *
 * `layerMemory` keeps notes in the memory of one isolate: a request that reaches another isolate
 * does not see them.
 */
export class Notes extends Context.Service<Notes, NotesService>()("@workspace/api/notes/Notes") {
  /**
   * Notes held in memory, newest first per owner.
   */
  static readonly layerMemory = Layer.effect(
    Notes,
    Effect.gen(function* buildMemoryNotes() {
      const store = yield* Ref.make<ReadonlyMap<OwnerId, readonly Note[]>>(new Map());

      const heldBy = (owner: OwnerId) =>
        Effect.map(Ref.get(store), (notes) => notes.get(owner) ?? []);

      const replace = (owner: OwnerId, notes: readonly Note[]) =>
        Ref.update(store, (current) => new Map(current).set(owner, notes));

      const find = Effect.fnUntraced(function* find(owner: OwnerId, id: NoteIdType) {
        const held = yield* heldBy(owner);
        const note = held.find((candidate) => candidate.id === id);

        if (note === undefined) {
          return yield* new NoteNotFound({ id });
        }

        return note;
      });

      const mintId = Effect.gen(function* mintId() {
        const high = yield* Random.nextInt;
        const low = yield* Random.nextInt;

        return NoteId.make(`${high.toString(16)}${low.toString(16)}`);
      });

      const list: NotesService["list"] = (owner) => heldBy(owner);

      const create: NotesService["create"] = Effect.fn("Notes.create")(
        function* create(owner, input) {
          const held = yield* heldBy(owner);

          if (held.length >= NOTES_MAX_PER_OWNER) {
            return yield* new NoteQuotaExceeded({ limit: NOTES_MAX_PER_OWNER });
          }

          const now = yield* DateTime.now;

          const note = new Note({
            body: input.body,
            createdAt: now,
            id: yield* mintId,
            title: input.title,
            updatedAt: now,
          });

          yield* replace(owner, [note, ...held]);

          return note;
        },
      );

      const get: NotesService["get"] = Effect.fn("Notes.get")(find);

      const update: NotesService["update"] = Effect.fn("Notes.update")(
        function* update(owner, id, patch) {
          const existing = yield* find(owner, id);
          const held = yield* heldBy(owner);

          const updated = new Note({
            body: patch.body ?? existing.body,
            createdAt: existing.createdAt,
            id: existing.id,
            title: patch.title ?? existing.title,
            updatedAt: yield* DateTime.now,
          });

          yield* replace(
            owner,
            held.map((note) => (note.id === id ? updated : note)),
          );

          return updated;
        },
      );

      const remove: NotesService["remove"] = Effect.fn("Notes.remove")(function* remove(owner, id) {
        yield* find(owner, id);

        const held = yield* heldBy(owner);

        yield* replace(
          owner,
          held.filter((note) => note.id !== id),
        );
      });

      return Notes.of({ create, get, list, remove, update });
    }),
  );
}
