import { BunServices } from "@effect/platform-bun";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Path } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/**
 * Runs `git check-ignore -q` for a repository-relative path and returns git's exit code:
 * 0 when the path is ignored, 1 when it is not.
 */
const checkIgnore = (target: string) =>
  Effect.gen(function* run() {
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const cwd = yield* path.fromFileUrl(new URL("..", import.meta.url));

    return yield* spawner.exitCode(
      ChildProcess.make("git", ["check-ignore", "-q", target], { cwd }),
    );
  }).pipe(Effect.provide(BunServices.layer));

describe("git check-ignore", () => {
  for (const target of [".env", ".env.local", ".env.op", ".alchemy/x"]) {
    it.effect(`ignores ${target}`, () =>
      Effect.gen(function* ignored() {
        assert.strictEqual(yield* checkIgnore(target), 0);
      }),
    );
  }

  it.effect(".env.example is not ignored", () =>
    Effect.gen(function* notIgnored() {
      assert.strictEqual(yield* checkIgnore(".env.example"), 1);
    }),
  );
});
