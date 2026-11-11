import { and, desc, eq, sql } from "drizzle-orm";
import { Context, DateTime, Effect, Layer, Random, Ref, Schema } from "effect";
import type { SqlError } from "effect/sql/SqlError";
import { batch } from "@workspace/db/batch";
import type { makeDatabase } from "@workspace/db/database";
import type { UserId } from "@workspace/contract/domain/session";
import { Note, NoteBody, NoteId, NoteTitle } from "@workspace/contract/domain/note";
import type { NoteCreate, NotePatch } from "@workspace/contract/domain/note";
import { NoteNotFound, NoteQuotaExceeded } from "@workspace/contract/domain/note-errors";
import { NOTES_MAX_PER_OWNER, noteQuota, notes as noteRows } from "./table.ts";

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
 * The per-execution accessor of the app database, as `makeDatabase` returns it. Evaluating it
 * outside an execution scope is a defect.
 */
export class NotesDatabase extends Context.Service<
  NotesDatabase,
  Effect.Success<ReturnType<typeof makeDatabase>>
>()("@workspace/api/notes/NotesDatabase") {}

/**
 * The D1 error text of the quota constraint, named in `table.ts`.
 */
const QUOTA_CONSTRAINT = "note_quota_used_le_max";

/**
 * Whether a failed batch broke the quota constraint. D1 reports it as `CHECK constraint failed:
 * note_quota_used_le_max`.
 *
 * @param failure - The failure of the batch.
 * @returns `true` when the underlying error names `note_quota_used_le_max`.
 */
const violatesQuota = (failure: SqlError) =>
  String(failure.reason.cause).includes(QUOTA_CONSTRAINT);

/**
 * The live count of an owner's notes, as a subquery.
 *
 * @param owner - The owner.
 * @returns The `count(*)` expression the quota row is set from.
 */
const countOf = (owner: OwnerId) =>
  sql`(SELECT count(*) FROM ${noteRows} WHERE ${noteRows.ownerId} = ${owner})`;

/**
 * Die when a title or body is over the contract's bound. The HTTP payload is already bounded, so
 * only a direct caller of the store reaches this.
 *
 * @param fields - The title and body that are about to be stored.
 * @param fields.body - The body, when the caller names one.
 * @param fields.title - The title, when the caller names one.
 * @returns Nothing when both are within bounds.
 */
const requireWithinBounds = (fields: {
  readonly body?: string | undefined;
  readonly title?: string | undefined;
}) =>
  (fields.title === undefined || Schema.is(NoteTitle)(fields.title)) &&
  (fields.body === undefined || Schema.is(NoteBody)(fields.body))
    ? Effect.void
    : Effect.die("A note title or body is over its size cap.");

/**
 * Mint the id of a new note.
 */
const mintId = Effect.gen(function* mintId() {
  const high = yield* Random.nextInt;
  const low = yield* Random.nextInt;

  return NoteId.make(`${high.toString(16)}${low.toString(16)}`);
});

/**
 * A stored row as the contract's `Note`.
 *
 * @param row - A row of `notes`.
 * @returns The note.
 */
const toNote = (row: typeof noteRows.$inferSelect) =>
  new Note({
    body: row.body,
    createdAt: DateTime.makeUnsafe(row.createdAt),
    id: NoteId.make(row.id),
    title: row.title,
    updatedAt: DateTime.makeUnsafe(row.updatedAt),
  });

/**
 * The service behind the notes endpoints.
 *
 * `layerMemory` keeps notes in the memory of one isolate: a request that reaches another isolate
 * does not see them.
 */
export class Notes extends Context.Service<Notes, NotesService>()("@workspace/api/notes/Notes") {
  /**
   * Notes stored in the app D1 database. Every write is one `batch`; the named `CHECK` on
   * `note_quota` refuses a create past `max`.
   *
   * @param max - The most notes one owner may hold, written into `note_quota.max` at each create.
   * @returns The layer, over {@link NotesDatabase}.
   */
  static readonly layer = (max: number = NOTES_MAX_PER_OWNER) =>
    Layer.effect(
      Notes,
      Effect.gen(function* buildD1Notes() {
        const database = (yield* NotesDatabase).pipe(Effect.orDie);

        const list: NotesService["list"] = Effect.fn("Notes.list")(function* list(owner) {
          const { db } = yield* database;

          const rows = yield* db
            .select()
            .from(noteRows)
            .where(eq(noteRows.ownerId, owner))
            .orderBy(desc(noteRows.createdAt))
            .pipe(Effect.orDie);

          return rows.map(toNote);
        });

        const get: NotesService["get"] = Effect.fn("Notes.get")(function* get(owner, id) {
          const { db } = yield* database;

          const rows = yield* db
            .select()
            .from(noteRows)
            .where(and(eq(noteRows.id, id), eq(noteRows.ownerId, owner)))
            .pipe(Effect.orDie);

          const [row] = rows;

          if (row === undefined) {
            return yield* new NoteNotFound({ id });
          }

          return toNote(row);
        });

        const create: NotesService["create"] = Effect.fn("Notes.create")(
          function* create(owner, input) {
            yield* requireWithinBounds(input);

            const { client, db } = yield* database;
            const now = DateTime.toEpochMillis(yield* DateTime.now);
            const id = yield* mintId;

            yield* batch(client, [
              db.insert(noteRows).values({
                body: input.body,
                createdAt: now,
                id,
                ownerId: owner,
                title: input.title,
                updatedAt: now,
              }),
              db
                .insert(noteQuota)
                .values({ max, ownerId: owner, used: countOf(owner) })
                .onConflictDoUpdate({
                  set: { max, used: countOf(owner) },
                  target: noteQuota.ownerId,
                }),
            ]).pipe(
              Effect.catchTag("SqlError", (error) =>
                violatesQuota(error)
                  ? Effect.fail(new NoteQuotaExceeded({ limit: max }))
                  : Effect.die(error),
              ),
            );

            return new Note({
              body: input.body,
              createdAt: DateTime.makeUnsafe(now),
              id,
              title: input.title,
              updatedAt: DateTime.makeUnsafe(now),
            });
          },
        );

        const update: NotesService["update"] = Effect.fn("Notes.update")(
          function* update(owner, id, patch) {
            yield* requireWithinBounds(patch);

            const { db } = yield* database;

            const rows = yield* db
              .update(noteRows)
              .set({
                body: patch.body,
                title: patch.title,
                updatedAt: DateTime.toEpochMillis(yield* DateTime.now),
              })
              .where(and(eq(noteRows.id, id), eq(noteRows.ownerId, owner)))
              .returning()
              .pipe(Effect.orDie);

            const [row] = rows;

            if (row === undefined) {
              return yield* new NoteNotFound({ id });
            }

            return toNote(row);
          },
        );

        const remove: NotesService["remove"] = Effect.fn("Notes.remove")(
          function* remove(owner, id) {
            const { client, db } = yield* database;

            const [deleted] = yield* batch(client, [
              db
                .delete(noteRows)
                .where(and(eq(noteRows.id, id), eq(noteRows.ownerId, owner)))
                .returning({ id: noteRows.id }),
              db
                .update(noteQuota)
                .set({ used: countOf(owner) })
                .where(eq(noteQuota.ownerId, owner)),
            ]).pipe(Effect.orDie);

            if (deleted.length === 0) {
              yield* new NoteNotFound({ id });
            }
          },
        );

        return Notes.of({ create, get, list, remove, update });
      }),
    );

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
