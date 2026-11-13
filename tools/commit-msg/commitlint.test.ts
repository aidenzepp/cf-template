import { BunServices } from "@effect/platform-bun";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/**
 * Runs the repository's commitlint configuration on one message and returns the exit code.
 */
const lint = (message: string, workspace?: string) =>
  Effect.gen(function* run() {
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const root = yield* path.fromFileUrl(new URL("../../", import.meta.url));

    return yield* spawner.exitCode(
      ChildProcess.make(
        path.join(root, "node_modules/.bin/commitlint"),
        workspace === undefined ? [] : ["--config", path.join(root, "commitlint.config.mjs")],
        {
          cwd: workspace ?? root,
          stdin: Stream.make(new TextEncoder().encode(message)),
        },
      ),
    );
  }).pipe(Effect.provide(BunServices.layer));

describe("commitlint configuration", () => {
  for (const message of [
    "feat(web): add x",
    "fix(tools)!: drop y",
    "Merge branch 'dep'",
    "feat(web): add x\n\nsee https://example.com/a/very/long/url/that/runs/past/the/one/hundred/character/limit/of/a/body/line/x",
    'Revert "feat: x"',
    "chore(release): 1.2.3-rc.1+build.5 [skip ci]",
  ]) {
    it.effect(`accepts ${JSON.stringify(message)}`, () =>
      Effect.gen(function* accepted() {
        assert.strictEqual(yield* lint(message), 0);
      }),
    );
  }

  for (const message of [
    "wip: x",
    "style: x",
    "feat(nope): x",
    "feat(web,api): x",
    "feat(): x",
    "feat: ",
    `feat: ${"x".repeat(96)}`,
    "feat x",
    "Feat: x",
    " feat: x",
    "feat: x\n\nCo-Authored-By: A <a@b.c>",
    "feat: x\n\nco-authored-by: A <a@b.c>",
    "feat: x\n\nbody\nCo-Authored-By: A <a@b.c>\n\nmore",
    "Merge branch 'dep'\n\nCo-Authored-By: A <a@b.c>",
  ]) {
    it.effect(`rejects ${JSON.stringify(message)}`, () =>
      Effect.gen(function* rejected() {
        assert.strictEqual(yield* lint(message), 1);
      }),
    );
  }

  it.effect("accepts a workspace added without a config edit", () =>
    Effect.gen(function* scratch() {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* path.fromFileUrl(new URL("../../", import.meta.url));
      const dir = path.join(root, "work", "commit-msg-scratch");

      yield* fs.makeDirectory(path.join(dir, "apps", "newbie"), { recursive: true });
      yield* fs.writeFileString(path.join(dir, "package.json"), '{"workspaces":["apps/*"]}');

      assert.strictEqual(yield* lint("feat(newbie): add x", dir), 0);
      assert.strictEqual(yield* lint("feat(web): add x", dir), 1);
      assert.strictEqual(yield* lint("feat(tools): add x", dir), 0);
    }).pipe(
      Effect.ensuring(
        Effect.gen(function* clean() {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* path.fromFileUrl(new URL("../../", import.meta.url));

          yield* fs.remove(path.join(root, "work", "commit-msg-scratch"), {
            force: true,
            recursive: true,
          });
        }).pipe(Effect.orDie),
      ),
      Effect.provide(BunServices.layer),
    ),
  );
});
