import { BunServices } from "@effect/platform-bun";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { findings } from "./check.ts";

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
 * Reads the real repository's local configuration: every key name, plus the values of the keys a
 * stray `git init` or `git config` would change. Other values, such as remote URLs, are never read.
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
    names: yield* config(["--list", "--name-only"]),
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
  "apps/auth/drizzle.config.ts",
  "apps/auth/src/db/schema.ts",
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

        yield* fs.writeFileString(
          table,
          source.replace(
            'title: text("title").notNull(),',
            'title: text("title").notNull(),\n  extra: text("extra"),',
          ),
        );

        const lines = yield* findings(root);

        assert.isTrue(lines.some((line) => line.startsWith("db:check ungenerated: apps/api: ")));
        assert.isFalse(lines.some((line) => line.includes("apps/auth")));
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
