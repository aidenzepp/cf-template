import { BunServices } from "@effect/platform-bun";
import { assert, layer } from "@effect/vitest";
import { Array as Arr, Context, Effect, Exit, FileSystem, Layer, Order, Path } from "effect";
import { Miniflare } from "miniflare";
import { makeDatabase } from "@workspace/db/database";
import type { RawDatabase } from "@workspace/db/database";
import {
  NOTE_BODY_MAX_LENGTH,
  NOTE_TITLE_MAX_LENGTH,
  NoteId,
} from "@workspace/contract/domain/note";
import { UserId } from "@workspace/contract/domain/session";
import { Notes, NotesDatabase } from "./notes.ts";

/**
 * Two owners private to one test, so the tests share a database without sharing rows.
 *
 * @param test - The test's name.
 * @returns The two owners.
 */
const owners = (test: string) => ({
  ada: UserId.make(`${test}-ada`),
  grace: UserId.make(`${test}-grace`),
});

/**
 * The generated migrations, in order, as single statements.
 */
const migrationStatements = Effect.gen(function* readMigrations() {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* path.fromFileUrl(new URL("../../migrations/", import.meta.url));
  const files = Arr.sort(yield* fs.readDirectory(directory, { recursive: true }), Order.String);

  return yield* Effect.forEach(
    files.filter((file) => file.endsWith(".sql")),
    (file) =>
      fs
        .readFileString(path.join(directory, file))
        .pipe(
          Effect.map((sql) =>
            sql
              .split("--> statement-breakpoint")
              .map((statement) => statement.replaceAll(/\s+/gu, " ").trim()),
          ),
        ),
  ).pipe(Effect.map((perFile) => perFile.flat()));
}).pipe(Effect.provide(BunServices.layer));

/**
 * A Miniflare D1 with the app migrations applied, closed with the layer's scope.
 */
class LocalAppDb extends Context.Service<LocalAppDb, RawDatabase>()("@workspace/api/LocalAppDb") {
  static readonly layer = Layer.effect(
    LocalAppDb,
    Effect.gen(function* startAppDb() {
      const miniflare = yield* Effect.acquireRelease(
        Effect.sync(() => new Miniflare({ d1Databases: ["DB"], modules: true, script: "" })),
        (instance) => Effect.promise(() => instance.dispose()),
      );

      const binding = yield* Effect.promise(() => miniflare.getD1Database("DB"));

      const statements = yield* migrationStatements;

      yield* Effect.promise(() =>
        binding.batch(statements.map((statement) => binding.prepare(statement))),
      );

      return binding;
    }),
  );
}

/**
 * The notes store over the local database, with a quota of two.
 */
const stack = Layer.provideMerge(
  Notes.layer(2),
  Layer.effect(
    NotesDatabase,
    Effect.gen(function* buildDatabase() {
      const raw = yield* LocalAppDb;

      return yield* makeDatabase(raw);
    }),
  ),
).pipe(Layer.provideMerge(LocalAppDb.layer));

/**
 * Runs `use` as one request: one execution scope, so the database is built once for it.
 *
 * @param use - The request body.
 * @returns The result of `use`.
 */
const request = <A, E, R>(use: Effect.Effect<A, E, R>) => Effect.scoped(use);

layer(stack, { excludeTestServices: true })("Notes.layer on local D1", (it) => {
  it.effect("keeps notes across separate requests, newest first, per owner", () =>
    Effect.gen(function* acrossRequests() {
      const notes = yield* Notes;
      const { ada, grace } = owners("order");

      const first = yield* request(notes.create(ada, { body: "one", title: "First" }));

      yield* Effect.sleep(5);

      const second = yield* request(notes.create(ada, { body: "two", title: "Second" }));
      const listed = yield* request(notes.list(ada));

      assert.deepStrictEqual(
        listed.map(({ id }) => id),
        [second.id, first.id],
      );
      assert.deepStrictEqual(yield* request(notes.list(grace)), []);
    }),
  );

  it.effect("answers a foreign id NoteNotFound and changes nothing", () =>
    Effect.gen(function* isolation() {
      const notes = yield* Notes;
      const { ada, grace } = owners("foreign");

      const note = yield* request(notes.create(ada, { body: "mine", title: "Mine" }));

      const read = yield* Effect.flip(request(notes.get(grace, note.id)));
      const patch = yield* Effect.flip(request(notes.update(grace, note.id, { title: "Taken" })));
      const remove = yield* Effect.flip(request(notes.remove(grace, note.id)));

      assert.deepStrictEqual(
        [read._tag, patch._tag, remove._tag],
        ["NoteNotFound", "NoteNotFound", "NoteNotFound"],
      );
      assert.strictEqual((yield* request(notes.get(ada, note.id))).title, "Mine");
    }),
  );

  it.effect("updates through one statement and bumps updatedAt", () =>
    Effect.gen(function* patching() {
      const notes = yield* Notes;
      const { ada } = owners("patch");

      const note = yield* request(notes.create(ada, { body: "b", title: "t" }));

      yield* Effect.sleep(5);

      const updated = yield* request(notes.update(ada, note.id, { title: "renamed" }));

      assert.strictEqual(updated.title, "renamed");
      assert.strictEqual(updated.body, "b");
      assert.strictEqual(updated.createdAt.epochMilliseconds, note.createdAt.epochMilliseconds);
      assert.isTrue(updated.updatedAt.epochMilliseconds > note.updatedAt.epochMilliseconds);
    }),
  );

  it.effect("serializes two concurrent creates at the quota and rolls the loser back", () =>
    Effect.gen(function* quota() {
      const notes = yield* Notes;
      const { ada, grace } = owners("quota");

      yield* request(notes.create(ada, { body: "", title: "one" }));

      const results = yield* Effect.all(
        [
          request(notes.create(ada, { body: "", title: "a" })),
          request(notes.create(ada, { body: "", title: "b" })),
        ],
        { concurrency: 2, mode: "result" },
      );

      const failures = results.filter((result) => result._tag === "Failure");

      assert.strictEqual(failures.length, 1);
      assert.strictEqual((yield* request(notes.list(ada))).length, 2);

      const refused = yield* Effect.flip(request(notes.create(ada, { body: "", title: "c" })));

      assert.strictEqual(refused._tag, "NoteQuotaExceeded");
      assert.isTrue(refused._tag === "NoteQuotaExceeded" && refused.limit === 2);
      assert.strictEqual((yield* request(notes.list(ada))).length, 2);

      yield* request(notes.create(grace, { body: "", title: "hers" }));
    }),
  );

  it.effect("frees quota on delete", () =>
    Effect.gen(function* freeing() {
      const notes = yield* Notes;
      const { ada } = owners("free");

      const one = yield* request(notes.create(ada, { body: "", title: "one" }));

      yield* request(notes.create(ada, { body: "", title: "two" }));
      yield* request(notes.remove(ada, one.id));
      yield* request(notes.create(ada, { body: "", title: "three" }));

      assert.strictEqual((yield* request(notes.list(ada))).length, 2);
    }),
  );

  it.effect("deletes for an owner with no quota row and inserts none", () =>
    Effect.gen(function* noQuotaRow() {
      const notes = yield* Notes;
      const raw = yield* LocalAppDb;
      const { ada } = owners("noquota");

      yield* Effect.promise(() =>
        raw
          .prepare(
            "INSERT INTO notes (id, owner_id, title, body, created_at, updated_at) VALUES ('legacy', ?, 't', 'b', 1, 1)",
          )
          .bind(ada)
          .run(),
      );

      yield* request(notes.remove(ada, NoteId.make("legacy")));

      const rows = yield* Effect.promise(() =>
        raw.prepare("SELECT owner_id FROM note_quota WHERE owner_id = ?").bind(ada).all(),
      );

      assert.deepStrictEqual(rows.results, []);
      assert.deepStrictEqual(yield* request(notes.list(ada)), []);
    }),
  );

  it.effect("lets an owner above a lowered max delete", () =>
    Effect.gen(function* lowered() {
      const notes = yield* Notes;
      const { ada } = owners("lowered");

      const first = yield* request(notes.create(ada, { body: "", title: "one" }));

      yield* request(notes.create(ada, { body: "", title: "two" }));

      const strict = yield* Notes.pipe(Effect.provide(Notes.layer(1)));

      assert.strictEqual(
        (yield* Effect.flip(request(strict.create(ada, { body: "", title: "x" }))))._tag,
        "NoteQuotaExceeded",
      );

      yield* request(strict.remove(ada, first.id));

      assert.strictEqual((yield* request(notes.list(ada))).length, 1);
    }),
  );

  it.effect("dies on a title or body over the cap and stores nothing", () =>
    Effect.gen(function* caps() {
      const notes = yield* Notes;
      const { ada } = owners("caps");

      const title = yield* Effect.exit(
        request(notes.create(ada, { body: "", title: "t".repeat(NOTE_TITLE_MAX_LENGTH + 1) })),
      );

      const body = yield* Effect.exit(
        request(notes.create(ada, { body: "b".repeat(NOTE_BODY_MAX_LENGTH + 1), title: "t" })),
      );

      assert.isTrue(Exit.hasDies(title));
      assert.isTrue(Exit.hasDies(body));
      assert.deepStrictEqual(yield* request(notes.list(ada)), []);
    }),
  );
});
