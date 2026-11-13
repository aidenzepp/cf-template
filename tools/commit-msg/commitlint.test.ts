import { BunServices } from "@effect/platform-bun";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Path, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/**
 * Runs the repository's commitlint configuration on one message and returns the exit code.
 */
const lint = (message: string) =>
  Effect.gen(function* run() {
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const cwd = yield* path.fromFileUrl(new URL("../../", import.meta.url));

    return yield* spawner.exitCode(
      ChildProcess.make("./node_modules/.bin/commitlint", [], {
        cwd,
        stdin: Stream.make(new TextEncoder().encode(message)),
      }),
    );
  }).pipe(Effect.provide(BunServices.layer));

describe("commitlint configuration", () => {
  for (const message of [
    "feat(web): add x",
    "fix(tools)!: drop y",
    "Merge branch 'dep'",
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
});
