import { assert, it } from "@effect/vitest";
import type { DateTime } from "effect";
import type { Session } from "@workspace/contract/domain/session";
import type { session, user } from "./schema.ts";

/**
 * The stored form of a field: brands erased to their base type and a UTC `DateTime` stored as
 * Unix milliseconds.
 */
type Stored<T> = T extends DateTime.Utc ? number : T extends string ? string : T;

/**
 * The contract's `Session` as the Better Auth tables hold it.
 */
type SessionRow = { readonly [K in keyof Session]: Stored<Session[K]> };

/**
 * The columns `Session` reads: display fields from `user`, expiry and user id from `session`.
 */
type TableRow = Pick<typeof user.$inferSelect, "email" | "image" | "name"> &
  Pick<typeof session.$inferSelect, "expiresAt" | "userId">;

/**
 * Each `Session` field as the table's `Date` mapped to Unix milliseconds, to match `Stored`.
 */
type TableStored = {
  readonly [K in keyof TableRow]: TableRow[K] extends Date ? number : TableRow[K];
};

/**
 * Resolves to `true` only when each of `A` and `B` is assignable to the other. Objects with
 * different key sets are not mutually assignable, so a column or field on one side only fails.
 */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/**
 * Compiles only when `T` is `true`; the type check inside `vp check` is the test.
 */
type Expect<T extends true> = T;

/**
 * A column dropped or retyped, or a `Session` field with no column, fails here.
 */
export type RowEqualsSession = Expect<Same<TableStored, SessionRow>>;

/**
 * The session's user id column keeps the type of the user's id column.
 */
export type UserIdMatchesUser = Expect<
  Same<(typeof session.$inferSelect)["userId"], (typeof user.$inferSelect)["id"]>
>;

it("ties Session to the user and session tables at compile time", () => {
  assert.isTrue(true);
});
