import { expect, layer } from "@effect/vitest";
import { defineRelations } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { Effect } from "effect";
import { LocalD1 } from "../test/miniflare.ts";
import { makeDatabase } from "./database.ts";

const items = sqliteTable("items", { id: text().primaryKey(), n: integer().notNull() });

const tags = sqliteTable("tags", {
  id: text().primaryKey(),
  itemId: text("item_id").notNull(),
});

const relations = defineRelations({ items, tags }, (r) => ({
  items: { tags: r.many.tags({ from: r.items.id, to: r.tags.itemId }) },
  tags: { item: r.one.items({ from: r.tags.itemId, to: r.items.id }) },
}));

layer(LocalD1.layer)("makeDatabase", (it) => {
  it.effect("shares one { db, client } inside an execution and builds one per execution", () =>
    Effect.gen(function* oneClientPerExecution() {
      const raw = yield* LocalD1;
      const database = yield* makeDatabase(raw);

      const [first, second] = yield* Effect.scoped(
        Effect.all([database, database], { concurrency: 1 }),
      );

      const other = yield* Effect.scoped(database);

      expect(second).toBe(first);
      expect(other).not.toBe(first);
      expect(other.client).not.toBe(first.client);
    }),
  );

  it.effect("answers a joined read through db.query when given relations", () =>
    Effect.scoped(
      Effect.gen(function* joinedRead() {
        const raw = yield* LocalD1;
        const database = yield* makeDatabase(raw, relations);
        const { db } = yield* database;

        yield* db.insert(items).values({ id: "a", n: 1 });
        yield* db.insert(tags).values({ id: "t", itemId: "a" });

        const item = yield* db.query.items.findFirst({ with: { tags: true } });
        const tag = yield* db.query.tags.findFirst({ with: { item: true } });

        expect(item?.tags).toStrictEqual([{ id: "t", itemId: "a" }]);
        expect(tag?.item).toStrictEqual({ id: "a", n: 1 });
      }),
    ),
  );
});
