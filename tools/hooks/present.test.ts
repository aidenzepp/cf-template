import { BunServices } from "@effect/platform-bun";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/**
 * Git exports these to hooks such as `pre-push`; left in place they would aim the test's git
 * commands at the repository running the hook instead of the temporary one.
 */
const gitEnvironment = {
  GIT_COMMON_DIR: undefined,
  GIT_DIR: undefined,
  GIT_INDEX_FILE: undefined,
  GIT_PREFIX: undefined,
  GIT_WORK_TREE: undefined,
};

/**
 * Runs `command` in `cwd` and returns its exit code and stderr.
 */
const run = Effect.fn("hooks.test.run")(function* run(
  cwd: string,
  command: string,
  args: readonly string[],
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  return yield* Effect.scoped(
    Effect.gen(function* spawned() {
      const handle = yield* spawner.spawn(
        ChildProcess.make(command, args, { cwd, env: gitEnvironment, extendEnv: true }),
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

describe("presence check", () => {
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
