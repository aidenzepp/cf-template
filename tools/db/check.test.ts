import { BunServices } from "@effect/platform-bun";
import { assert, it } from "@effect/vitest";
import { Config, Effect, FileSystem, Layer, Path, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { findings, run } from "./check.ts";

/**
 * Runs `git` in `cwd` with the environment inherited exactly as a hook would see it, and returns
 * its trimmed stdout, or an empty string when git exits non-zero (an unset key).
 */
const inherited = Effect.fn("db.test.inherited")(function* inherited(
  cwd: string,
  args: ReadonlyArray<string>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  return yield* Effect.scoped(
    Effect.gen(function* spawned() {
      const handle = yield* spawner.spawn(ChildProcess.make("git", args, { cwd }));

      const [stdout, code] = yield* Effect.all(
        [Stream.mkString(Stream.decodeText(handle.stdout)), handle.exitCode],
        { concurrency: 2 },
      );

      return code === 0 ? stdout.trim() : "";
    }),
  );
});

/**
 * Reads the real repository's local configuration: the names of its `core.*` and `vp.*` keys, plus
 * the values of the keys a stray `git init` or `git config` would change. Other keys are never
 * read: the clone's worktrees share this file, and another worktree's `git push -u` adds
 * `branch.*` and `remote.*` keys at any moment, so comparing every name fails this suite
 * intermittently. Other values, such as remote URLs, are never read.
 */
const realConfiguration = Effect.fn("db.test.realConfiguration")(function* realConfiguration() {
  const path = yield* Path.Path;
  const here = yield* path.fromFileUrl(new URL(".", import.meta.url));
  const common = path.resolve(here, yield* inherited(here, ["rev-parse", "--git-common-dir"]));

  const config = (args: ReadonlyArray<string>) =>
    inherited(here, [`--git-dir=${common}`, "config", "--local", ...args]);

  return {
    bare: yield* config(["--get", "core.bare"]),
    hooksPath: yield* config(["--get", "core.hookspath"]),
    names: (yield* config(["--list", "--name-only"]))
      .split("\n")
      .filter((name) => /^(?:core|vp)\./u.test(name)),
    worktree: yield* config(["--get", "core.worktree"]),
  };
});

/**
 * Snapshots the real repository's configuration before the suite and fails the suite if it differs
 * afterwards.
 */
const realRepositoryUnchanged = Layer.effectDiscard(
  Effect.acquireRelease(Effect.orDie(realConfiguration()), (before) =>
    Effect.orDie(realConfiguration()).pipe(
      Effect.flatMap((after) =>
        Effect.sync(() => {
          assert.deepStrictEqual(after, before);
        }),
      ),
    ),
  ),
).pipe(Layer.provide(BunServices.layer));

/**
 * The files of the real tree a check reads: both databases' configuration, schema and migrations.
 */
const copied = [
  "apps/api/drizzle.config.ts",
  "apps/api/src/db/schema.ts",
  "apps/api/src/notes/table.ts",
  "apps/api/migrations",
  "apps/auth/auth.config.ts",
  "apps/auth/drizzle.config.ts",
  "apps/auth/package.json",
  "apps/auth/src",
  "apps/auth/migrations",
];

/**
 * Copies those files into a directory under this worktree's `work/`, removed when the scope ends,
 * links each app's `node_modules`, and returns its path.
 */
const scratchTree = Effect.fn("db.test.scratchTree")(function* scratchTree() {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repo = yield* path.fromFileUrl(new URL("../..", import.meta.url));

  yield* fs.makeDirectory(path.join(repo, "work"), { recursive: true });

  const root = yield* fs.makeTempDirectoryScoped({
    directory: path.join(repo, "work"),
    prefix: "db-check-test-",
  });

  yield* Effect.all(
    copied.map((file) =>
      fs
        .makeDirectory(path.dirname(path.join(root, file)), { recursive: true })
        .pipe(Effect.andThen(fs.copy(path.join(repo, file), path.join(root, file)))),
    ),
  );

  // The schemas import `drizzle-orm`, which is installed under each app, not at the root.
  yield* Effect.all(
    ["apps/api", "apps/auth"].map((app) =>
      fs.symlink(path.join(repo, app, "node_modules"), path.join(root, app, "node_modules")),
    ),
  );

  return root;
});

/**
 * Adds a migration named `added` holding the fixture's SQL to `database` in `root`, and returns
 * what `dangerous-sql` prints for it.
 */
const fixtureFindings = Effect.fn("db.test.fixtureFindings")(function* fixtureFindings(
  fixture: string,
  database: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* scratchTree();
  const added = path.join(root, database, "migrations/99999999999999_added");

  yield* fs.makeDirectory(added);
  yield* fs.copyFile(
    yield* path.fromFileUrl(new URL(`fixtures/${fixture}/migration.sql`, import.meta.url)),
    path.join(added, "migration.sql"),
  );

  return (yield* findings(root, { only: ["dangerous-sql"] })).join("\n");
});

/**
 * Builds a throwaway git repository under this worktree's `work/` whose base commit holds the
 * notes table module, its schema barrel, a test importer and a creating migration, and, when
 * `importer` is set, a non-test module importing the table module. Its working tree then adds a
 * migration dropping `notes` and `note_quota`. Returns the root and the base commit.
 */
const dropRepository = Effect.fn("db.test.dropRepository")(function* dropRepository(
  importer: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repo = yield* path.fromFileUrl(new URL("../..", import.meta.url));

  yield* fs.makeDirectory(path.join(repo, "work"), { recursive: true });

  const root = yield* fs.makeTempDirectoryScoped({
    directory: path.join(repo, "work"),
    prefix: "db-check-git-",
  });

  const write = (file: string, text: string) =>
    fs
      .makeDirectory(path.dirname(path.join(root, file)), { recursive: true })
      .pipe(Effect.andThen(fs.writeFileString(path.join(root, file), text)));

  const git = (...args: ReadonlyArray<string>) =>
    run(root, "git", [
      "-C",
      root,
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ]);

  const tests = 'import { notes } from "./table.ts";\nexport const read = notes;\n';

  yield* git("init", "-q");
  yield* write("apps/api/src/db/schema.ts", 'export * from "../notes/table.ts";\n');
  yield* write(
    "apps/api/src/notes/table.ts",
    'export const notes = sqliteTable("notes", {});\nexport const noteQuota = sqliteTable("note_quota", {});\n',
  );
  yield* write("apps/api/src/notes/notes.test.ts", tests);
  yield* write("apps/api/src/notes/notes.ts", importer ? tests : "export const read = 1;\n");
  yield* write(
    "apps/api/migrations/20260101000000_init/migration.sql",
    "CREATE TABLE `notes` (`id` text PRIMARY KEY);--> statement-breakpoint\nCREATE TABLE `note_quota` (`owner_id` text PRIMARY KEY);\n",
  );
  yield* git("add", "-A");
  yield* git("commit", "-q", "-m", "base");
  yield* write(
    "apps/api/migrations/20260102000000_drop/migration.sql",
    "DROP TABLE `notes`;--> statement-breakpoint\nDROP TABLE `note_quota`;\n",
  );

  return { base: (yield* git("rev-parse", "HEAD")).trim(), root };
});

/**
 * Runs the real `.vite-hooks/pre-push` in `root` with only `PATH` and `HOME` set and a `bun` on
 * `PATH` that exits 0, so only the hook's own lines decide the result. Returns its exit code and
 * stderr.
 */
const prePush = Effect.fn("db.test.prePush")(function* prePush(root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const bin = path.join(root, "stub");

  yield* fs.makeDirectory(bin, { recursive: true });
  yield* fs.writeFileString(path.join(bin, "bun"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

  const env = {
    HOME: yield* Config.String("HOME"),
    PATH: `${bin}:${yield* Config.String("PATH")}`,
  };

  const hook = yield* path.fromFileUrl(new URL("../../.vite-hooks/pre-push", import.meta.url));

  return yield* Effect.scoped(
    Effect.gen(function* spawned() {
      const handle = yield* spawner.spawn(
        ChildProcess.make("sh", [hook], { cwd: root, env, extendEnv: false }),
      );

      const [stderr, code] = yield* Effect.all(
        [Stream.mkString(Stream.decodeText(handle.stderr)), handle.exitCode],
        { concurrency: 2 },
      );

      return { code: Number(code), stderr: stderr.trim() };
    }),
  );
});

const timeout = { timeout: 120_000 };

it.layer(realRepositoryUnchanged)("db:check", () => {
  it.effect(
    "passes on a clean tree",
    () =>
      Effect.gen(function* clean() {
        assert.deepStrictEqual(yield* findings(yield* scratchTree()), []);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    timeout,
  );

  it.effect(
    "ungenerated fails a schema edit with no migration",
    () =>
      Effect.gen(function* edited() {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* scratchTree();
        const table = path.join(root, "apps/api/src/notes/table.ts");
        const source = yield* fs.readFileString(table);
        const anchor = 'kind: text("kind").notNull(),';

        assert.include(source, anchor);

        yield* fs.writeFileString(
          table,
          source.replace(anchor, `${anchor}\n    extra: text("extra"),`),
        );

        const lines = yield* findings(root);

        assert.isTrue(lines.some((line) => line.startsWith("db:check ungenerated: apps/api: ")));
        assert.isFalse(lines.some((line) => line.includes("apps/auth")));
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    timeout,
  );

  it.effect(
    "dangerous-sql fails the recorded recreate of a referenced table",
    () =>
      Effect.gen(function* recreate() {
        assert.match(
          yield* fixtureFindings("recreate", "apps/auth"),
          /^db:check dangerous-sql: apps\/auth\/migrations\/[^/]+\/migration\.sql: recreates user,/u,
        );
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    timeout,
  );

  it.effect(
    "dangerous-sql fails ADD COLUMN NOT NULL without DEFAULT",
    () =>
      Effect.gen(function* notNull() {
        assert.match(
          yield* fixtureFindings("not-null-no-default", "apps/auth"),
          /^db:check dangerous-sql: apps\/auth\/migrations\/[^/]+\/migration\.sql: ADD COLUMN NOT NULL without DEFAULT/u,
        );
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    timeout,
  );

  it.effect(
    "dangerous-sql fails a drop while a non-test module still imports the table, then passes",
    () =>
      Effect.gen(function* twoPhase() {
        const red = yield* dropRepository(true);

        const phase1 = (yield* findings(red.root, {
          base: red.base,
          only: ["dangerous-sql"],
        })).join("\n");

        assert.match(
          phase1,
          /dangerous-sql: .*: drops notes, still read by apps\/api\/src\/notes\/notes\.ts at /u,
        );
        assert.match(phase1, /drops note_quota, still read by apps\/api\/src\/notes\/notes\.ts/u);
        assert.notInclude(phase1, "notes.test.ts");

        const green = yield* dropRepository(false);

        assert.deepStrictEqual(
          yield* findings(green.root, { base: green.base, only: ["dangerous-sql"] }),
          [],
        );
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    timeout,
  );

  it.effect(
    "auth-schema fails the stale-auth-schema fixture, naming the file",
    () =>
      Effect.gen(function* stale() {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* scratchTree();

        yield* fs.copyFile(
          yield* path.fromFileUrl(
            new URL("fixtures/stale-auth-schema/schema.txt", import.meta.url),
          ),
          path.join(root, "apps/auth/src/db/schema.ts"),
        );

        assert.deepStrictEqual(yield* findings(root, { only: ["auth-schema"] }), [
          "db:check auth-schema: apps/auth/src/db/schema.ts: differs from what the Better Auth CLI generates on Node; run bun run auth:generate",
        ]);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    timeout,
  );

  it.effect(
    "pre-push refuses an uncommitted migration, then proceeds once it is committed",
    () =>
      Effect.gen(function* hook() {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const repo = yield* path.fromFileUrl(new URL("../..", import.meta.url));

        yield* fs.makeDirectory(path.join(repo, "work"), { recursive: true });

        const root = yield* fs.makeTempDirectoryScoped({
          directory: path.join(repo, "work"),
          prefix: "db-check-hook-",
        });

        const git = (...args: ReadonlyArray<string>) =>
          run(root, "git", [
            "-C",
            root,
            "-c",
            "user.name=test",
            "-c",
            "user.email=test@example.com",
            "-c",
            "commit.gpgsign=false",
            ...args,
          ]);

        const migration = path.join(root, "apps/x/migrations/20260101000000_new");

        yield* git("init", "-q");
        yield* git("commit", "-q", "--allow-empty", "-m", "base");
        yield* fs.makeDirectory(migration, { recursive: true });
        yield* fs.writeFileString(
          path.join(migration, "migration.sql"),
          "CREATE TABLE `x` (`id` text);\n",
        );

        assert.deepStrictEqual(yield* prePush(root), {
          code: 1,
          stderr: "uncommitted migrations under apps/*/migrations/; commit them before pushing",
        });

        yield* git("add", "apps/x/migrations");
        yield* git("commit", "-q", "-m", "migration");

        assert.deepStrictEqual(yield* prePush(root), { code: 0, stderr: "" });
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    timeout,
  );

  it.effect(
    "minimal-set fails the edited-migration fixture, naming the file",
    () =>
      Effect.gen(function* handEdited() {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* scratchTree();
        const migrations = path.join(root, "apps/api/migrations");
        const [name] = yield* fs.readDirectory(migrations);

        yield* fs.copyFile(
          yield* path.fromFileUrl(
            new URL("fixtures/edited-migration/migration.sql", import.meta.url),
          ),
          path.join(migrations, name ?? "", "migration.sql"),
        );

        assert.match(
          (yield* findings(root)).join("\n"),
          /^db:check minimal-set: apps\/api\/migrations\/[^/]+\/migration\.sql: /mu,
        );
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    timeout,
  );
});
