import { assert, it } from "@effect/vitest";
import type { DateTime } from "effect";
import type { Note } from "@workspace/contract/domain/note";
import { NOTES_MAX_PER_OWNER, noteQuota } from "./table.ts";
import type { NoteServerOnlyColumns, notes } from "./table.ts";

/**
 * The stored form of a field: brands erased to their base type and a UTC `DateTime` stored as
 * Unix milliseconds.
 */
type Stored<T> = T extends DateTime.Utc ? number : T extends string ? string : T;

/**
 * The contract's `Note` as its table row holds it.
 */
type NoteRow = { readonly [K in keyof Note]: Stored<Note[K]> };

/**
 * The `notes` row without its server-only columns.
 */
type TableRow = Omit<typeof notes.$inferSelect, NoteServerOnlyColumns>;

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
 * A table column missing from `Note` fails here, and so does a `Note` field missing from the table.
 */
export type RowEqualsNote = Expect<Same<TableRow, NoteRow>>;

it("keeps the quota limit and the quota table owner key", () => {
  assert.strictEqual(NOTES_MAX_PER_OWNER, 100);
  assert.deepStrictEqual(Object.keys(noteQuota).includes("ownerId"), true);
});
