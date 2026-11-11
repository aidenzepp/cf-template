import type { D1Client } from "@effect/sql-d1/D1Client";
import type { NonEmptyReadonlyArray } from "effect/Array";

/**
 * A Drizzle builder reduced to what `batch` reads from it: its compiled SQL and parameters.
 */
interface Compilable {
  toSQL: () => { readonly params: readonly unknown[]; readonly sql: string };
}

/**
 * Runs the builders as one D1 batch, the only all-or-nothing write: D1 commits every statement or
 * none, and a failing statement fails the whole call with a `SqlError`. Each builder is compiled
 * with `.toSQL()` and keeps its typed parameters; a lone statement needs no batch and stays a plain
 * builder. D1's own error reports a batch over its limits (100 parameters and 100 KB per statement,
 * 30 s). A load split across several batches can land partially and is not atomic.
 *
 * This is the one module that hands compiled SQL to `client.unsafe`, because `D1Client.batch` takes
 * client statements and Drizzle's own D1 session does the same for every query.
 */
export const batch = (client: D1Client, builders: NonEmptyReadonlyArray<Compilable>) =>
  client.batch(
    builders.map((builder) => {
      const { params, sql } = builder.toSQL();

      return client.unsafe(sql, params);
    }),
  );
