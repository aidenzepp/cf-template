#!/usr/bin/env bun
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Array as Arr, Console, Effect, FileSystem, Option, Order, Path, Schema } from "effect";
import { databases } from "./check-model.ts";
import type { Check, Finding } from "./check-model.ts";
import { dangerousSql } from "./dangerous-sql.ts";
import { gitLines, run } from "./run.ts";

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
 * Whether `version`, the output of `node --version`, is at least 22.12, the floor the Better Auth
 * CLI needs.
 */
const nodeSupported = (version: string) => {
  const found = /^v(?<major>\d+)\.(?<minor>\d+)/u.exec(version)?.groups;
  const [major, minor] = [Number(found?.major), Number(found?.minor)];

  return major > 22 || (major === 22 && minor >= 12);
};

/**
 * The auth app's directory in a tree, the one database whose schema the Better Auth CLI generates.
 */
const AUTH_APP = "apps/auth";

/**
 * Runs the Better Auth CLI on Node over the auth app in the tree at `root`, with the same config as
 * the `auth:generate` script and `--output` set to a scratch file under `work/`, which is removed
 * when the scope ends. Returns the schema text it wrote, or `undefined` when it wrote none. The run
 * loads the app's configuration and its dependency graph, so it takes seconds on a cold machine.
 */
export const generatedAuthSchema = Effect.fn("db.check.generatedAuthSchema")(
  function* generatedAuthSchema(root: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    yield* fs.makeDirectory(path.join(root, "work"), { recursive: true });

    const scratch = path.join(
      yield* fs.makeTempDirectoryScoped({
        directory: path.join(root, "work"),
        prefix: "db-check-auth-",
      }),
      "schema.ts",
    );

    yield* run(path.join(root, AUTH_APP), "node", [
      "./node_modules/.bin/auth",
      "generate",
      "--config",
      "./auth.config.ts",
      "--output",
      scratch,
      "--yes",
    ]);

    return (yield* fs.exists(scratch)) ? yield* fs.readFileString(scratch) : undefined;
  },
  Effect.scoped,
);

/**
 * `auth-schema`: the committed `apps/auth/src/db/schema.ts` equals what the Better Auth CLI
 * generates from `apps/auth/auth.config.ts`, run on Node, since Bun's output differs. The
 * `auth:generate` script also runs `drizzle-kit generate` and the digest step, so the check invokes
 * only its CLI part, through {@link generatedAuthSchema}, unless the context already carries the
 * generated text.
 */
const authSchema: Check = {
  name: "auth-schema",
  run: Effect.fn("db.check.authSchema")(function* authSchema(context, database) {
    if (database.name !== AUTH_APP) {
      return [];
    }

    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const subject = `${database.name}/src/db/schema.ts`;

    if (context.authSchema === undefined) {
      const version = yield* run(context.root, "node", ["--version"]).pipe(Effect.option);

      if (Option.isNone(version) || !nodeSupported(version.value)) {
        return [
          {
            reason: `${Option.match(version, { onNone: () => "not found on PATH", onSome: (found) => `${found.trim()} is too old` })}; install Node >= 22.12, which the Better Auth CLI needs`,
            subject: "node",
          },
        ];
      }
    }

    const generated = context.authSchema ?? (yield* generatedAuthSchema(context.root));

    return generated === (yield* fs.readFileString(path.join(context.root, subject)))
      ? []
      : [
          {
            reason:
              "differs from what the Better Auth CLI generates on Node; run bun run auth:generate",
            subject,
          },
        ];
  }),
};

/**
 * The checks, in the order their findings print.
 */
const checks: ReadonlyArray<Check> = [ungenerated, minimalSet, dangerousSql, authSchema];

/**
 * The names of the checks, in the order their findings print.
 */
export const checkNames = checks.map((check) => check.name);

/**
 * Runs the checks named in `only` (all when omitted) over every database in the tree at `root` and
 * returns one `db:check <check>: <file or database>: <reason>` line per finding. `base` is the ref
 * `dangerous-sql` compares against, default `git merge-base HEAD origin/main`. `authSchema` is the
 * text the Better Auth CLI generates, when the caller ran it already; `auth-schema` then runs no
 * CLI.
 */
export const findings = Effect.fn("db.check.findings")(function* findings(
  root: string,
  options: {
    readonly authSchema?: string | undefined;
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
            Effect.all(
              databases.map((database) =>
                check.run({ authSchema: options.authSchema, base, kit, root }, database),
              ),
              { concurrency: "unbounded" },
            ).pipe(
              Effect.map((perDatabase) =>
                perDatabase
                  .flat()
                  .map((found) => `db:check ${check.name}: ${found.subject}: ${found.reason}`),
              ),
            ),
          ]
        : [],
    ),
    { concurrency: "unbounded" },
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
