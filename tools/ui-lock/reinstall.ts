import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { sonnerComponent, stockComponents } from "./components.ts";
import { componentsDirectory, lockFile, writeLock } from "./lock.ts";
import { themeFile, writeTheme } from "./theme.ts";

/**
 * Runs `bun run ui add <names> --overwrite --yes` and fails when it exits non-zero.
 */
const add = Effect.fn("ui-lock.add")(function* add(names: ReadonlyArray<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const code = yield* Effect.scoped(
    Effect.gen(function* spawned() {
      const handle = yield* spawner.spawn(
        ChildProcess.make("bun", ["run", "ui", "add", ...names, "--overwrite", "--yes"], {
          stderr: "inherit",
          stdout: "inherit",
        }),
      );

      return yield* handle.exitCode;
    }),
  );

  return yield* code === 0
    ? Effect.void
    : Effect.die(`ui add ${names.join(" ")} exited with code ${code}`);
});

/**
 * Reinstalls the stock list, then `sonner` separately, then rewrites the lock and restores the
 * stock stylesheet `globals.css`, which `add` never rewrites. The only writer of the lock file.
 */
export const reinstall = Effect.fn("ui-lock.reinstall")(function* reinstall() {
  yield* add(stockComponents);
  yield* add([sonnerComponent]);
  yield* writeLock(componentsDirectory, lockFile);
  yield* writeTheme(themeFile);
});

if (import.meta.main) {
  BunRuntime.runMain(reinstall().pipe(Effect.provide(BunServices.layer)));
}
