import { BunServices } from "@effect/platform-bun";
import { assert, it } from "@effect/vitest";
import { Config, Effect, FileSystem, Layer, Path, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/**
 * The environment every spawned command receives: only `PATH` and `HOME`, with `extendEnv` off,
 * so no inherited `GIT_*` variable (git exports several to hooks such as `pre-push`) can aim a
 * command at the repository that is running the tests instead of the temporary one. Fails if a
 * `GIT_DIR` ever appears outside `cwd`.
 */
const isolatedEnvironment = Effect.fn("hooks.test.environment")(function* isolatedEnvironment(
  cwd: string,
) {
  const environment = {
    HOME: yield* Config.String("HOME"),
    PATH: yield* Config.String("PATH"),
  };

  const entries = Object.entries(environment);

  assert.isTrue(
    entries.every(([key, value]) => key !== "GIT_DIR" || value.startsWith(cwd)),
    "GIT_DIR must stay inside cwd",
  );
  assert.deepStrictEqual(
    entries.filter(([key]) => key.startsWith("GIT_")),
    [],
  );

  return environment;
});

/**
 * Runs `command` in `cwd` and returns its exit code and stderr.
 */
const run = Effect.fn("hooks.test.run")(function* run(
  cwd: string,
  command: string,
  args: ReadonlyArray<string>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const env = yield* isolatedEnvironment(cwd);

  return yield* Effect.scoped(
    Effect.gen(function* spawned() {
      const handle = yield* spawner.spawn(
        ChildProcess.make(command, args, { cwd, env, extendEnv: false }),
      );

      const [stderr, code] = yield* Effect.all(
        [Stream.mkString(Stream.decodeText(handle.stderr)), handle.exitCode],
        { concurrency: 2 },
      );

      return { code, stderr: stderr.trim() };
    }),
  );
});

/**
 * Runs `git` in `cwd` with the environment inherited exactly as a hook would see it, and returns
 * its trimmed stdout, or an empty string when git exits non-zero (an unset key).
 */
const inherited = Effect.fn("hooks.test.inherited")(function* inherited(
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
 * stray `git init` or `git config` would change. Values of other keys, such as remote URLs, are
 * never read.
 */
const realConfiguration = Effect.fn("hooks.test.realConfiguration")(function* realConfiguration() {
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
 * afterwards, so a test that writes to the repository running it cannot pass.
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
 * Creates a git repository under this worktree's `work/` directory, removed when the scope ends.
 * With `mode` set, `core.hooksPath` points at a `hooks` directory holding a `pre-push` of that
 * mode.
 */
const repository = Effect.fn("hooks.test.repository")(function* repository(mode?: number) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const work = yield* path.fromFileUrl(new URL("../../work", import.meta.url));

  yield* fs.makeDirectory(work, { recursive: true });

  const root = yield* fs.makeTempDirectoryScoped({ directory: work, prefix: "hooks-" });

  yield* run(root, "git", ["init", "--quiet"]);

  if (mode !== undefined) {
    yield* fs.makeDirectory(path.join(root, "hooks"));
    yield* fs.writeFileString(path.join(root, "hooks", "pre-push"), "#!/bin/sh\n");
    yield* fs.chmod(path.join(root, "hooks", "pre-push"), mode);
    yield* run(root, "git", ["config", "--local", "core.hooksPath", "hooks"]);
  }

  return root;
});

const script = new URL("present.ts", import.meta.url).pathname;

it.layer(realRepositoryUnchanged)("presence check", () => {
  it.effect("exits 0 when pre-push resolves and is executable", () =>
    Effect.gen(function* executable() {
      const root = yield* repository(0o755);

      assert.strictEqual((yield* run(root, "bun", [script])).code, 0);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.effect("exits 1 with the message when core.hooksPath is unset", () =>
    Effect.gen(function* unset() {
      const root = yield* repository();
      const result = yield* run(root, "bun", [script]);

      assert.strictEqual(result.code, 1);
      assert.match(result.stderr, /pre-push hook not resolvable in .+: run bun install/u);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.effect("exits 1 when pre-push is not executable", () =>
    Effect.gen(function* notExecutable() {
      const root = yield* repository(0o644);

      assert.strictEqual((yield* run(root, "bun", [script])).code, 1);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.effect("exits 0 outside a work tree", () =>
    Effect.gen(function* outside() {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const work = yield* path.fromFileUrl(new URL("../../work", import.meta.url));

      yield* fs.makeDirectory(work, { recursive: true });

      const root = yield* fs.makeTempDirectoryScoped({ directory: work, prefix: "plain-" });

      // `work/` sits inside this repository, so the plain directory needs a git boundary above it.
      const result = yield* run(root, "env", [`GIT_CEILING_DIRECTORIES=${work}`, "bun", script]);

      assert.strictEqual(result.code, 0);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );
});
