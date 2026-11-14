import { BunRuntime, BunServices } from "@effect/platform-bun";
import {
  Array as Arr,
  Config,
  Console,
  Effect,
  FileSystem,
  Option,
  Order,
  Path,
  Schema,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/**
 * The databases that own migrations. Each `config` is the `drizzle-kit` configuration that writes
 * the database's `migrations/` directory from its schema.
 */
const databases = [
  { config: "apps/api/drizzle.config.ts", name: "apps/api" },
  { config: "apps/auth/drizzle.config.ts", name: "apps/auth" },
] as const;

/**
 * The files `drizzle-kit generate` writes into every migration directory, and no others.
 */
const generatedFiles = new Set(["migration.sql", "snapshot.json"]);

/**
 * What `drizzle-kit generate --explain --output json` prints: `no_changes`, or `ok` with the
 * planned statements.
 */
const Explain = Schema.fromJsonString(
  Schema.Struct({ status: Schema.Literals(["no_changes", "ok"]) }),
);

/**
 * One problem a check found: the file or database it concerns and the reason.
 */
interface Finding {
  readonly reason: string;
  readonly subject: string;
}

/**
 * Where a run happens: the tree being checked and the `drizzle-kit` binary that checks it.
 */
interface Context {
  readonly base: string | undefined;
  readonly kit: string;
  readonly root: string;
}

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
 * A named check over one database. P2 and P3 add checks by appending to `checks`.
 */
interface Check {
  readonly name: string;
  readonly run: (
    context: Context,
    database: (typeof databases)[number],
  ) => Effect.Effect<
    ReadonlyArray<Finding>,
    | Config.ConfigError
    | Effect.Error<ReturnType<FileSystem.FileSystem["stat"]>>
    | Schema.SchemaError,
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
  >;
}

/**
 * Runs `command` in `cwd` with only `PATH` and `HOME` in its environment, so no inherited `GIT_*`
 * variable can aim it at another repository, and returns its stdout.
 */
export const run = Effect.fn("db.check.run")(function* run(
  cwd: string,
  command: string,
  args: ReadonlyArray<string>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const env = { HOME: yield* Config.String("HOME"), PATH: yield* Config.String("PATH") };

  return yield* Effect.scoped(
    Effect.gen(function* spawned() {
      const handle = yield* spawner.spawn(
        ChildProcess.make(command, args, { cwd, env, extendEnv: false, stderr: "ignore" }),
      );

      return yield* Stream.mkString(Stream.decodeText(handle.stdout));
    }),
  );
});

/**
 * `ungenerated`: the schema has no change the committed migrations lack.
 */
const ungenerated: Check = {
  name: "ungenerated",
  run: Effect.fn("db.check.ungenerated")(function* ungenerated(context, database) {
    const path = yield* Path.Path;
    const config = path.join(context.root, database.config);

    const stdout = yield* run(path.dirname(config), context.kit, [
      "generate",
      "--config",
      path.basename(config),
      "--explain",
      "--output",
      "json",
    ]);

    const { status } = yield* Schema.decodeEffect(Explain)(stdout.trim());

    return status === "ok"
      ? [
          {
            reason: "the schema has changes with no migration; run bun run db:generate",
            subject: database.name,
          },
        ]
      : [];
  }),
};

/**
 * `minimal-set`: every migration directory holds only generated files, and the newest migration
 * equals what the generator produces from the schema and the snapshots before it. The generator
 * runs into a scratch directory under `work/`, which is removed when the check ends.
 */
const minimalSet: Check = {
  name: "minimal-set",
  run: Effect.fn("db.check.minimalSet")(function* minimalSet(context, database) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const app = path.join(context.root, database.name);
    const migrations = path.join(app, "migrations");
    const names = Arr.sort(yield* fs.readDirectory(migrations), Order.String);

    const extras: ReadonlyArray<Finding> = (yield* Effect.forEach(names, (name) =>
      fs.readDirectory(path.join(migrations, name)).pipe(
        Effect.map((entries) =>
          entries
            .filter((entry) => !generatedFiles.has(entry))
            .map((entry) => ({
              reason: "not a file drizzle-kit generates",
              subject: `${database.name}/migrations/${name}/${entry}`,
            })),
        ),
      ),
    )).flat();

    const newest = names.at(-1);

    if (newest === undefined) {
      return extras;
    }

    yield* fs.makeDirectory(path.join(context.root, "work"), { recursive: true });

    const scratch = yield* fs.makeTempDirectoryScoped({
      directory: path.join(context.root, "work"),
      prefix: "db-check-",
    });

    yield* fs.copy(migrations, path.join(scratch, "migrations"));
    yield* fs.remove(path.join(scratch, "migrations", newest), { recursive: true });
    yield* run(app, context.kit, [
      "generate",
      "--dialect",
      "sqlite",
      "--schema",
      path.join(app, "src/db/schema.ts"),
      "--out",
      path.join(scratch, "migrations"),
    ]);

    const generated = (yield* fs.readDirectory(path.join(scratch, "migrations"))).find(
      (name) => !names.includes(name),
    );

    const committed = yield* fs.readFileString(path.join(migrations, newest, "migration.sql"));

    const regenerated =
      generated === undefined
        ? undefined
        : yield* fs.readFileString(path.join(scratch, "migrations", generated, "migration.sql"));

    return [
      ...extras,
      ...(committed === regenerated
        ? []
        : [
            {
              reason: "differs from what the generator produces from the committed snapshots",
              subject: `${database.name}/migrations/${newest}/migration.sql`,
            },
          ]),
    ];
  }, Effect.scoped),
};

/**
 * Splits migration SQL into statements on the `--> statement-breakpoint` markers and `;` that
 * `drizzle-kit` emits.
 */
const statements = (sql: string): ReadonlyArray<string> =>
  sql
    .split(/-->\s*statement-breakpoint|;/u)
    .map((statement) => statement.trim())
    .filter((statement) => statement !== "");

/**
 * Whether `patterns` each match a later statement than the one before, in order.
 */
const inOrder = (all: ReadonlyArray<string>, patterns: ReadonlyArray<RegExp>): boolean => {
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
const captured = (pattern: RegExp, statement: string): ReadonlyArray<string> =>
  Arr.fromNullishOr(pattern.exec(statement)?.groups?.name);

/**
 * The tables a migration recreates: each `__new_<t>` with the four-statement sequence `CREATE`,
 * `INSERT ... SELECT`, `DROP TABLE <t>`, `RENAME TO <t>`.
 */
const recreated = (all: ReadonlyArray<string>): ReadonlyArray<string> =>
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
 * Runs `git -C root <args>` with only `PATH` and `HOME` in its environment and returns the output
 * as lines.
 */
const gitLines = Effect.fn("db.check.gitLines")(function* gitLines(
  root: string,
  args: ReadonlyArray<string>,
) {
  return (yield* run(root, "git", ["-C", root, ...args])).split("\n").filter((line) => line !== "");
});

/**
 * A module path without its `.ts` or `.tsx` extension, so `./table` and `./table.ts` compare equal.
 */
const bare = (module: string): string => module.replace(/\.tsx?$/u, "");

/**
 * Whether an import statement in `source` (type-only imports and re-exports included) names
 * `target`, a repository path, from the module at `file`. Only relative specifiers are resolved.
 */
const imports = (path: Path.Path, source: string, file: string, target: string): boolean =>
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
const dangerousSql: Check = {
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

/**
 * Whether `version`, the output of `node --version`, is at least 22.12, the floor the Better Auth
 * CLI needs.
 */
const nodeSupported = (version: string): boolean => {
  const found = /^v(?<major>\d+)\.(?<minor>\d+)/u.exec(version)?.groups;
  const [major, minor] = [Number(found?.major), Number(found?.minor)];

  return major > 22 || (major === 22 && minor >= 12);
};

/**
 * `auth-schema`: the committed `apps/auth/src/db/schema.ts` equals what the Better Auth CLI
 * generates from `apps/auth/auth.config.ts`, run on Node, since Bun's output differs. The
 * `auth:generate` script also runs `drizzle-kit generate` and the digest step, so the check invokes
 * only its CLI part, with the same config and `--output` set to a scratch file under `work/`,
 * which is removed when the check ends.
 */
const authSchema: Check = {
  name: "auth-schema",
  run: Effect.fn("db.check.authSchema")(function* authSchema(context, database) {
    if (database.name !== "apps/auth") {
      return [];
    }

    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const app = path.join(context.root, database.name);
    const subject = `${database.name}/src/db/schema.ts`;
    const version = yield* run(context.root, "node", ["--version"]).pipe(Effect.option);

    if (Option.isNone(version) || !nodeSupported(version.value)) {
      return [
        {
          reason: `${Option.match(version, { onNone: () => "not found on PATH", onSome: (found) => `${found.trim()} is too old` })}; install Node >= 22.12, which the Better Auth CLI needs`,
          subject: "node",
        },
      ];
    }

    yield* fs.makeDirectory(path.join(context.root, "work"), { recursive: true });

    const scratch = path.join(
      yield* fs.makeTempDirectoryScoped({
        directory: path.join(context.root, "work"),
        prefix: "db-check-auth-",
      }),
      "schema.ts",
    );

    yield* run(app, "node", [
      "./node_modules/.bin/auth",
      "generate",
      "--config",
      "./auth.config.ts",
      "--output",
      scratch,
      "--yes",
    ]);

    const generated = (yield* fs.exists(scratch)) ? yield* fs.readFileString(scratch) : undefined;

    return generated === (yield* fs.readFileString(path.join(context.root, subject)))
      ? []
      : [
          {
            reason:
              "differs from what the Better Auth CLI generates on Node; run bun run auth:generate",
            subject,
          },
        ];
  }, Effect.scoped),
};

/**
 * The checks, in the order their findings print.
 */
const checks: ReadonlyArray<Check> = [ungenerated, minimalSet, dangerousSql, authSchema];

/**
 * Runs the checks named in `only` (all when omitted) over every database in the tree at `root` and
 * returns one `db:check <check>: <file or database>: <reason>` line per finding. `base` is the ref
 * `dangerous-sql` compares against, default `git merge-base HEAD origin/main`.
 */
export const findings = Effect.fn("db.check.findings")(function* findings(
  root: string,
  options: {
    readonly base?: string | undefined;
    readonly only?: ReadonlyArray<string> | undefined;
  } = {},
) {
  const path = yield* Path.Path;

  const kit = yield* path.fromFileUrl(
    new URL("../../node_modules/.bin/drizzle-kit", import.meta.url),
  );

  const base = options.base ?? (yield* gitLines(root, ["merge-base", "HEAD", "origin/main"])).at(0);

  const lines = yield* Effect.all(
    checks.flatMap((check) =>
      options.only === undefined || options.only.includes(check.name)
        ? [
            Effect.all(databases.map((database) => check.run({ base, kit, root }, database))).pipe(
              Effect.map((perDatabase) =>
                perDatabase
                  .flat()
                  .map((found) => `db:check ${check.name}: ${found.subject}: ${found.reason}`),
              ),
            ),
          ]
        : [],
    ),
  );

  return lines.flat();
});

if (import.meta.main) {
  BunRuntime.runMain(
    Effect.gen(function* main() {
      const path = yield* Path.Path;
      const flag = process.argv.indexOf("--base");

      const lines = yield* findings(yield* path.fromFileUrl(new URL("../..", import.meta.url)), {
        base: flag === -1 ? undefined : process.argv[flag + 1],
      });

      yield* Effect.forEach(lines, (line) => Console.log(line), { discard: true });

      if (lines.length > 0) {
        yield* Effect.sync(() => {
          process.exitCode = 1;
        });
      }
    }).pipe(Effect.provide(BunServices.layer)),
  );
}
