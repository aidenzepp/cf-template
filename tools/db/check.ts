import { BunRuntime, BunServices } from "@effect/platform-bun";
import {
  Array as Arr,
  Config,
  Console,
  Effect,
  FileSystem,
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
  readonly kit: string;
  readonly root: string;
}

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
    unknown,
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
  >;
}

/**
 * Runs `command` in `cwd` with only `PATH` and `HOME` in its environment, so no inherited `GIT_*`
 * variable can aim it at another repository, and returns its stdout.
 */
const run = Effect.fn("db.check.run")(function* run(
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

    const { status } = yield* Schema.decodeUnknownEffect(Explain)(stdout.trim());

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

    const extras: ReadonlyArray<Finding> = (yield* Effect.all(
      names.map((name) =>
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
 * The checks, in the order their findings print.
 */
const checks: ReadonlyArray<Check> = [ungenerated, minimalSet];

/**
 * Runs every check over every database in the tree at `root` and returns one
 * `db:check <check>: <file or database>: <reason>` line per finding.
 */
export const findings = Effect.fn("db.check.findings")(function* findings(root: string) {
  const path = yield* Path.Path;

  const kit = yield* path.fromFileUrl(
    new URL("../../node_modules/.bin/drizzle-kit", import.meta.url),
  );

  const lines = yield* Effect.all(
    checks.map((check) =>
      Effect.all(databases.map((database) => check.run({ kit, root }, database))).pipe(
        Effect.map((perDatabase) =>
          perDatabase
            .flat()
            .map((found) => `db:check ${check.name}: ${found.subject}: ${found.reason}`),
        ),
      ),
    ),
  );

  return lines.flat();
});

if (import.meta.main) {
  BunRuntime.runMain(
    Effect.gen(function* main() {
      const path = yield* Path.Path;
      const lines = yield* findings(yield* path.fromFileUrl(new URL("../..", import.meta.url)));

      yield* Effect.all(lines.map((line) => Console.log(line)));

      if (lines.length > 0) {
        yield* Effect.sync(() => {
          process.exitCode = 1;
        });
      }
    }).pipe(Effect.provide(BunServices.layer)),
  );
}
