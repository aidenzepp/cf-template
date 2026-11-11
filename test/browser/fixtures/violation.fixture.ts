import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { commands } from "vite-plus/test/browser";
import type { BrowserCommands } from "vite-plus/test/internal/browser";

/**
 * A page with a seeded axe violation: an image with no text alternative (`image-alt`).
 */
const SEEDED_PAGE = "data:text/html,<title>seeded</title><main><img src=x></main>";

/**
 * The part of the `scan` command's result this fixture reads. The command is in
 * `vite.browser.config.ts`, and is custom, so the typed `commands` object does not name it.
 */
interface ScanCommand {
  readonly scan: (
    target: string,
  ) => Promise<{ readonly violations: ReadonlyArray<{ readonly id: string }> }>;
}

const hasScan = (candidate: BrowserCommands): candidate is BrowserCommands & ScanCommand =>
  "scan" in candidate;

const scanSeeded = Effect.gen(function* scanSeeded() {
  if (!hasScan(commands)) {
    return yield* Effect.die("The scan command is missing. Check vite.browser.config.ts.");
  }

  const seeded: ScanCommand = commands;

  return yield* Effect.promise(() => seeded.scan(SEEDED_PAGE));
});

/**
 * The seeded violation. Its suffix is one no include of any config matches, so no run picks it up
 * unless a command names it. The oracle runs it explicitly and expects a non-zero exit, which
 * proves that the `browser` tier fails on a real axe violation.
 */
describe("the seeded axe violation", () => {
  it.effect("has no violations, which fails on the missing image alternative", () =>
    Effect.gen(function* checkSeeded() {
      const { violations } = yield* scanSeeded;

      assert.deepStrictEqual(
        violations.map(({ id }) => id),
        [],
      );
    }),
  );
});
