# Write Migration Examples

Each example pairs one rule with this repository's tables. `POSITIVE` is the practice to follow.
`NEGATIVE` is what to avoid.

## Plan first, generate once

Adding a quota warning threshold to the notes database touches two tables.

POSITIVE: edit both modules in `apps/api/src/notes/table.ts`, then generate once.

```ts
// notes: add a pinned flag with a default
pinned: integer("pinned").notNull().default(0),
// note_quota: add the threshold with a default
warnAt: integer("warn_at").notNull().default(90),
```

```sh
bun run db:generate
```

One migration directory holds both `ALTER TABLE ... ADD` statements.

NEGATIVE: edit `notes`, generate, then edit `note_quota` and generate again. Two migrations ship
for one change, and the first holds a half-finished state.

## Read the SQL

POSITIVE: open the new `apps/api/migrations/<timestamp>_<name>/migration.sql` and confirm it holds
only the statements the plan called for.

```sql
ALTER TABLE `notes` ADD `pinned` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `note_quota` ADD `warn_at` integer DEFAULT 90 NOT NULL;
```

NEGATIVE: commit the directory because `bun run db:check` passed. The checks refuse unsafe SQL;
they do not know whether the SQL is the change you meant.

## No recreate of the auth `user` table

A change SQLite cannot express as `ALTER` on `user`, such as altering a column's constraints, makes
drizzle-kit rebuild the table. This is the SQL it emits, recorded at
`tools/db/fixtures/recreate/migration.sql`:

```sql
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_user` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`email` text NOT NULL UNIQUE,
	`email_verified` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_user`(`id`, `name`, `email`, `email_verified`) SELECT `id`, `name`, `email`, `email_verified` FROM `user`;--> statement-breakpoint
DROP TABLE `user`;--> statement-breakpoint
ALTER TABLE `__new_user` RENAME TO `user`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
```

`session` and `account` reference `user.id` with `ON DELETE CASCADE`, and D1 keeps foreign keys on,
so `DROP TABLE user` deletes every session and account row. `bun run db:check` prints:

```text
db:check dangerous-sql: apps/auth/migrations/<timestamp>_<name>/migration.sql: recreates user, which other tables reference; redesign it additively
```

## Redesign a blocked recreate additively

POSITIVE: leave `user` as it is and add what the change needs beside it, as a new nullable column
or a new table keyed by `user.id`. The generator emits `ALTER TABLE ... ADD` or `CREATE TABLE`.

```sql
ALTER TABLE `user` ADD `verified_at` integer;
```

NEGATIVE: hand-delete the `DROP TABLE` and `RENAME` lines to dodge the check. `minimal-set` fails
the edited file.

## A backfill is application code

POSITIVE: a new `note_quota.warn_at` that must start from each owner's current usage is filled by
application code that writes the quota row, under the application's error handling and tests.

NEGATIVE: append `UPDATE note_quota SET warn_at = max * 9 / 10;` to the generated
`migration.sql`. The file no longer matches the generator, and the data move has no tests.

## A running `alchemy dev` serves code before the migration applies

After `bun run db:generate` adds `apps/api/migrations/<timestamp>_<name>`, a running `alchemy dev`
reloads the Worker with the new table module while the local database still has the old columns.

POSITIVE: touch `infra/alchemy.run.ts`, or stop and restart `alchemy dev`, so the migration applies
before requests reach the new code.

NEGATIVE: test the new column straight after the edit and read the "no such column" error as a bug
in the code.
