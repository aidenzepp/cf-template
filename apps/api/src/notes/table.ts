import { check, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

/**
 * The most notes one owner may hold. A code constant, not a knob; each create writes it into the
 * owner's `note_quota.max`, so a changed value applies at the owner's next create.
 */
export const NOTES_MAX_PER_OWNER = 100;

/**
 * The stored notes. `owner_id` is an opaque identifier from the auth database, so there is no
 * foreign key and no cascade. Ids and timestamps (Unix milliseconds) are set in code.
 */
export const notes = sqliteTable("notes", {
  body: text("body").notNull(),
  createdAt: integer("created_at").notNull(),
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  title: text("title").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/**
 * The per-owner note counter. The named `CHECK` is what refuses a create past the limit: the D1
 * error text carries `note_quota_used_le_max`.
 */
export const noteQuota = sqliteTable(
  "note_quota",
  {
    max: integer("max").notNull(),
    ownerId: text("owner_id").primaryKey(),
    used: integer("used").notNull(),
  },
  (table) => [check("note_quota_used_le_max", sql`${table.used} <= ${table.max}`)],
);

/**
 * The `notes` columns that are not fields of the contract's `Note`. Adding a server-only column is
 * a deliberate edit here; any other new column fails the type test.
 */
export type NoteServerOnlyColumns = "ownerId";
