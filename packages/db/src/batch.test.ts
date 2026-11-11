import { describe, expect, it } from "@effect/vitest";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { Effect } from "effect";
import { rawDatabase } from "../test/miniflare.ts";
import { batch } from "./batch.ts";
import { makeDatabase } from "./database.ts";

const items = sqliteTable("items", { id: text().primaryKey(), n: integer().notNull() });

const execution = Effect.gen(function* openExecution() {
  const raw = yield* Effect.promise(() => rawDatabase());
  const database = yield* makeDatabase(raw);

  return { database, raw };
});

describe("batch", () => {
  it.effect("commits every statement of a batch", () =>
    Effect.scoped(
      Effect.gen(function* commits() {
        const { database } = yield* execution;
        const { client, db } = yield* database;

        yield* batch(client, [
          db.insert(items).values({ id: "a", n: 1 }),
          db.insert(items).values({ id: "b", n: 2 }),
        ]);

        const rows = yield* db.select().from(items).orderBy(items.id);

        expect(rows).toEqual([
          { id: "a", n: 1 },
          { id: "b", n: 2 },
        ]);
      }),
    ),
  );

  it.effect("leaves no row from earlier statements when the last violates the CHECK", () =>
    Effect.scoped(
      Effect.gen(function* rollsBack() {
        const { database } = yield* execution;
        const { client, db } = yield* database;

        yield* db.delete(items);

        const failure = yield* Effect.flip(
          batch(client, [
            db.insert(items).values({ id: "c", n: 3 }),
            db.insert(items).values({ id: "d", n: -1 }),
          ]),
        );

        const rows = yield* db.select().from(items);

        expect(failure._tag).toBe("SqlError");
        expect(rows).toEqual([]);
      }),
    ),
  );

  it.effect("D1 rejects BEGIN on Miniflare's exec, outside the package's exports", () =>
    Effect.gen(function* rejectsBegin() {
      const { raw } = yield* execution;
      const failure = yield* Effect.flip(Effect.tryPromise(() => raw.exec("BEGIN")));

      expect(String(failure.cause)).toMatch(/BEGIN/u);
    }),
  );
});
