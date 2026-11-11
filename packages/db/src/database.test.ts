import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { rawDatabase } from "../test/miniflare.ts";
import { makeDatabase } from "./database.ts";

describe("makeDatabase", () => {
  it.effect("shares one { db, client } inside an execution and builds one per execution", () =>
    Effect.gen(function* oneClientPerExecution() {
      const database = yield* Effect.flatMap(
        Effect.promise(() => rawDatabase()),
        makeDatabase,
      );

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
