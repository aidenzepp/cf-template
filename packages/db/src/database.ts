import * as D1Client from "@effect/sql-d1/D1Client";
import { makeExecutionMemo } from "alchemy/Runtime/ExecutionMemo";
import { makeWithDefaults } from "drizzle-orm/effect-d1";
import type { EffectSQLiteD1Database } from "drizzle-orm/effect-d1";
import type { AnyRelations, EmptyRelations } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";

/**
 * The raw Cloudflare `D1Database` binding, typed as the `@effect/sql-d1` client config expects it.
 */
export type RawDatabase = D1Client.D1ClientConfig["db"];

/**
 * One execution's database: the Drizzle query builder and the `D1Client` it runs on. `client` is
 * what `batch` needs; `db` builds the typed statements.
 */
interface Database<TRelations extends AnyRelations = EmptyRelations> {
  readonly client: D1Client.D1Client;
  readonly db: EffectSQLiteD1Database<TRelations>;
}

/**
 * Builds the database for one Worker from its raw `D1Database` binding and returns the
 * per-execution accessor. The accessor builds `{ db, client }` on its first run in an execution
 * scope (a Worker event, a Durable Object call) and returns the same pair for every later run in
 * that scope; a new execution builds a new pair. The client and its prepared-statement cache close
 * with the scope.
 *
 * This repeats the calls `Drizzle.D1` makes without its proxy, which blocks the promise view and
 * hides `.toSQL()` and `$client`. Call `makeDatabase` once per Worker at init and keep the
 * accessor. Never run it with `transaction`, `withTransaction` or `client.unsafe`: D1 has no
 * interactive transactions, so `batch` is the only atomic write.
 *
 * `relations` is the Drizzle relations object (`defineRelations` or `defineRelationsPart`) of the
 * Worker's schema. It fills `db.query` and `db._.relations`, which relational reads such as
 * `db.query.<table>.findFirst({ with })` and Better Auth's joined reads need. Omit it for a Worker
 * that runs no relational reads: `db.query` is then empty.
 */
export const makeDatabase = <TRelations extends AnyRelations = EmptyRelations>(
  raw: RawDatabase,
  relations?: TRelations,
) =>
  makeExecutionMemo(
    Effect.gen(function* buildDatabase() {
      const context = yield* Layer.build(D1Client.layer({ db: raw }));
      const client = Context.get(context, D1Client.D1Client);

      const db = yield* makeWithDefaults({ relations }).pipe(
        Effect.provideService(D1Client.D1Client, client),
      );

      return { client, db } satisfies Database<TRelations>;
    }),
  );
