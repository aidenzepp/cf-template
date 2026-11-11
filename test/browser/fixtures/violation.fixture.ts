import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { commands } from "vitest/browser";

/**
 * A page with a seeded axe violation: an image with no text alternative (`image-alt`).
 */
const SEEDED_PAGE = "data:text/html,<title>seeded</title><main><img src=x></main>";

/**
 * The seeded violation. Its suffix is one no include of any config matches, so no run picks it up
 * unless a command names it. The oracle runs it explicitly and expects a non-zero exit, which
 * proves that the `browser` tier fails on a real axe violation.
 */
describe("the seeded axe violation", () => {
  it.effect("has no violations, which fails on the missing image alternative", () =>
    Effect.gen(function* scanSeeded() {
      const { violations } = yield* Effect.promise(() => commands.scan(SEEDED_PAGE));

      assert.deepStrictEqual(
        violations.map(({ id }) => id),
        [],
      );
    }),
  );
});
