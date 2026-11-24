import { Array as Arr, Effect, FileSystem, Option, Order, Path, Schema } from "effect";
import type { Check, Context, databases } from "./check-model.ts";
import { gitLines, run } from "./run.ts";

/**
 * The part of a `drizzle-kit` snapshot `dangerous-sql` reads: each foreign key's table and target.
 */
const Snapshot = Schema.fromJsonString(
  Schema.Struct({
    ddl: Schema.Array(
      Schema.Struct({
        entityType: Schema.String,
        table: Schema.optionalKey(Schema.String),
        tableTo: Schema.optionalKey(Schema.String),
      }),
    ),
  }),
);

/**
 * Splits migration SQL into statements on the `--> statement-breakpoint` markers and `;` that
 * `drizzle-kit` emits.
 */
const statements = (sql: string) =>
  sql
    .split(/-->\s*statement-breakpoint|;/u)
    .map((statement) => statement.trim())
    .filter((statement) => statement !== "");

/**
 * Whether `patterns` each match a later statement than the one before, in order.
 */
const inOrder = (all: ReadonlyArray<string>, patterns: ReadonlyArray<RegExp>) => {
  let from = 0;

  for (const pattern of patterns) {
    const found = all.slice(from).findIndex((statement) => pattern.test(statement));

    if (found === -1) {
      return false;
    }

    from += found + 1;
  }

  return true;
};

/**
 * The table name captured by the named group `name` in `pattern`, as a list of zero or one.
 */
const captured = (pattern: RegExp, statement: string) =>
  Arr.fromNullishOr(pattern.exec(statement)?.groups?.name);

/**
 * The tables a migration recreates: each `__new_<t>` with the four-statement sequence `CREATE`,
 * `INSERT ... SELECT`, `DROP TABLE <t>`, `RENAME TO <t>`.
 */
const recreated = (all: ReadonlyArray<string>) =>
  all
    .flatMap((statement) => captured(/^CREATE TABLE [`"]__new_(?<name>\w+)[`"]/iu, statement))
    .filter((table) =>
      inOrder(all, [
        new RegExp(`^INSERT INTO [\`"]__new_${table}[\`"]`, "iu"),
        new RegExp(`^DROP TABLE [\`"]${table}[\`"]`, "iu"),
        new RegExp(`^ALTER TABLE [\`"]__new_${table}[\`"] RENAME TO [\`"]${table}[\`"]`, "iu"),
      ]),
    );

/**
 * A module path without its `.ts` or `.tsx` extension, so `./table` and `./table.ts` compare equal.
 */
const bare = (module: string) => module.replace(/\.tsx?$/u, "");

/**
 * Whether an import statement in `source` (type-only imports and re-exports included) names
 * `target`, a repository path, from the module at `file`. Only relative specifiers are resolved.
 */
const imports = (path: Path.Path, source: string, file: string, target: string) =>
  [...source.matchAll(/\b(?:from|import)\s*\(?\s*["'](?<specifier>\.[^"']*)["']/gu)].some(
    (match) => bare(path.join(path.dirname(file), match.groups?.specifier ?? "")) === bare(target),
  );

/**
 * The non-test modules at `base` other than `owner` that import the table module `module`. A
 * database's `schema.ts` only registers its table modules for `drizzle-kit`; it never reads them,
 * so it does not count.
 */
const readers = Effect.fn("db.check.readers")(function* readers(
  context: Context & { readonly base: string },
  schema: string,
  module: string,
) {
  const path = yield* Path.Path;
  const stem = path.basename(module).replace(/\.tsx?$/u, "");

  const candidates = (yield* gitLines(context.root, [
    "grep",
    "-l",
    "-F",
    stem,
    context.base,
    "--",
    "*.ts",
    "*.tsx",
  ]))
    .map((line) => line.slice(context.base.length + 1))
    .filter((file) => file !== module && file !== schema && !/\.test\.tsx?$/u.test(file));

  const sources = yield* Effect.forEach(candidates, (file) =>
    run(context.root, "git", ["-C", context.root, "show", `${context.base}:${file}`]),
  );

  return candidates.filter((file, index) => imports(path, sources[index] ?? "", file, module));
});

/**
 * Maps each table name to its table module at the base ref by reading the database's drizzle
 * schema: `schema.ts` itself and every relative module it re-exports, each scanned for
 * `sqliteTable("<name>"`. A table with no module at the base is new on this branch.
 */
const tableModule = Effect.fn("db.check.tableModule")(function* tableModule(
  context: Context & { readonly base: string },
  schema: string,
  table: string,
) {
  const path = yield* Path.Path;

  const show = (file: string) =>
    run(context.root, "git", ["-C", context.root, "show", `${context.base}:${file}`]);

  const barrel = yield* show(schema);

  const modules = [
    schema,
    ...[...barrel.matchAll(/export\s[^;]*?from\s*["'](?<specifier>\.[^"']*)["']/gu)].map((match) =>
      path.join(path.dirname(schema), match.groups?.specifier ?? ""),
    ),
  ];

  const sources = yield* Effect.forEach(modules, show);

  return modules.find((_, index) =>
    [...(sources[index] ?? "").matchAll(/sqliteTable\(\s*["'](?<name>\w+)["']/gu)].some(
      (match) => match.groups?.name === table,
    ),
  );
});

/**
 * The tables any other table's foreign key points at, from the newest committed snapshot.
 */
const referencedTables = Effect.fn("db.check.referencedTables")(function* referencedTables(
  migrations: string,
  names: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const present = yield* Effect.forEach(names, (name) =>
    fs.exists(path.join(migrations, name, "snapshot.json")),
  );

  const newest = Arr.last(names.filter((_, index) => present[index]));

  if (Option.isNone(newest)) {
    return new Set<string>();
  }

  const { ddl } = yield* Schema.decodeEffect(Snapshot)(
    yield* fs.readFileString(path.join(migrations, newest.value, "snapshot.json")),
  );

  return new Set(
    ddl.flatMap((entity) =>
      entity.entityType === "fks" && entity.table !== entity.tableTo && entity.tableTo !== undefined
        ? [entity.tableTo]
        : [],
    ),
  );
});

/**
 * The reason a `DROP TABLE` of `table` fails, or nothing when the table is no longer read at the
 * base ref: no importer other than its own table module, tests and `schema.ts` excluded.
 */
const dropFailure = Effect.fn("db.check.dropFailure")(function* dropFailure(
  context: Context,
  database: (typeof databases)[number],
  table: string,
) {
  const { base } = context;

  if (base === undefined) {
    return [`drops ${table}, but the base ref did not resolve; pass --base <ref>`];
  }

  const schema = `${database.name}/src/db/schema.ts`;
  const module = yield* tableModule({ ...context, base }, schema, table);

  if (module === undefined) {
    return [];
  }

  const files = yield* readers({ ...context, base }, schema, module);

  return files.length === 0
    ? []
    : [`drops ${table}, still read by ${files.join(", ")} at ${base}; stop reading it first`];
});

/**
 * `dangerous-sql`: in each migration added since the base ref, no recreate of a referenced table,
 * no `ADD COLUMN ... NOT NULL` without `DEFAULT`, and no `DROP TABLE` of a table still read.
 */
export const dangerousSql: Check = {
  name: "dangerous-sql",
  run: Effect.fn("db.check.dangerousSql")(function* dangerousSql(context, database) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const migrations = path.join(context.root, database.name, "migrations");

    if (!(yield* fs.exists(migrations))) {
      return [];
    }

    const existing =
      context.base === undefined
        ? []
        : yield* gitLines(context.root, [
            "ls-tree",
            "--name-only",
            context.base,
            `${database.name}/migrations/`,
          ]);

    const all = Arr.sort(yield* fs.readDirectory(migrations), Order.String);
    const added = all.filter((name) => !existing.includes(`${database.name}/migrations/${name}`));
    const referenced = yield* referencedTables(migrations, all);

    return (yield* Effect.forEach(added, (name) =>
      Effect.gen(function* migration() {
        const subject = `${database.name}/migrations/${name}/migration.sql`;

        const sql = statements(
          yield* fs.readFileString(path.join(migrations, name, "migration.sql")),
        );

        const recreates = recreated(sql);

        const drops = yield* Effect.all(
          sql
            .flatMap((statement) => captured(/^DROP TABLE [`"](?<name>\w+)[`"]/iu, statement))
            .flatMap((table) =>
              table.startsWith("__new_") || recreates.includes(table)
                ? []
                : [dropFailure(context, database, table)],
            ),
        );

        return [
          ...recreates.flatMap((table) =>
            referenced.has(table)
              ? [`recreates ${table}, which other tables reference; redesign it additively`]
              : [],
          ),
          ...sql
            .filter(
              (statement) =>
                /^ALTER TABLE\s+\S+\s+ADD(?:\s+COLUMN)?\s/iu.test(statement) &&
                /\bNOT NULL\b/iu.test(statement) &&
                !/\bDEFAULT\b/iu.test(statement),
            )
            .map(() => "ADD COLUMN NOT NULL without DEFAULT; add a DEFAULT or make it nullable"),
          ...drops.flat(),
        ].map((reason) => ({ reason, subject }));
      }),
    )).flat();
  }),
};
