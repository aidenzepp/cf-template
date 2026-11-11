import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { LocalD1 } from "../test/miniflare.ts";
import { makeDatabase } from "./database.ts";

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
});
