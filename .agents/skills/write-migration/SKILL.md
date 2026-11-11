---
name: write-migration
description: Change a database schema and its D1 migration safely. Use when editing a Drizzle table module under apps/api or apps/auth, adding or generating a migration, regenerating the auth schema, or when `bun run db:check` fails.
---

# Write Migration

Two databases hold migrations: `apps/api/migrations/` and `apps/auth/migrations/`. Migrations are
generated, never written. `bun run db:check` (part of `bun run check`) fails a schema edit with no
migration, a migration that differs from the generator's output, an unsafe migration, and a stale
`apps/auth/src/db/schema.ts`.

Before generating, read [references/examples.md](references/examples.md). It shows each rule below
on this repository's real tables, including the SQL a blocked recreate produces.

## Workflow

1. Plan every schema edit for the change before touching a table module. Decide the final tables,
   columns, defaults and keys, then make all the edits.
2. Generate once with `bun run db:generate`. A second generate for the same change leaves an extra
   migration for no reason; if the plan was wrong, restore the table modules and start again.
3. Run `bun run db:check`. Fix the schema or the plan, then regenerate; the checks name the file
   and the reason.
4. Read the SQL.
5. Commit the table modules and the new migration directory together.

## Rules

- No migration recreates the auth `user` table. `session` and `account` cascade from it, and D1 keeps
  foreign keys on, so the recreate's `DROP TABLE` deletes their rows. The same holds for any table
  another table's foreign key points at, whatever its `ON DELETE` action.
- A recreate that `db:check` blocks is redesigned additively first: add a column with a default, add
  a table, or add an index, so the generator emits `ALTER` or `CREATE` and no recreate.
- A backfill is application code, never a hand migration. Put the data move in code that runs
  under the application's own error handling and tests.

## Running stacks

Under a running `alchemy dev`, a code edit serves before a new migration applies, so the Worker can
run new code against the old schema. After adding a migration, touch the stack file
`infra/alchemy.run.ts` or restart `alchemy dev`.
