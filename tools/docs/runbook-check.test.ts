import { BunServices } from "@effect/platform-bun";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { checkRunbook, readBuildPlanLabels } from "./runbook-check.ts";

/**
 * The header of every runbook table in the tests.
 */
const header = [
  "## Section",
  "",
  "| Step | Command | Signal | Tag | Rests on |",
  "| ---- | ------- | ------ | --- | -------- |",
].join("\n");

/**
 * Reads `docs/architecture.md` and returns the labels its Build plan lists.
 */
const planLabels = Effect.fn("docs.test.planLabels")(function* planLabels() {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  return readBuildPlanLabels(
    yield* fs.readFileString(
      yield* path.fromFileUrl(new URL("../../docs/architecture.md", import.meta.url)),
    ),
  );
});

/**
 * Checks the fixture named `name` against the real Build plan labels.
 */
const checkFixture = Effect.fn("docs.test.checkFixture")(function* checkFixture(name: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  return checkRunbook(
    yield* fs.readFileString(
      yield* path.fromFileUrl(new URL(`fixtures/${name}.md`, import.meta.url)),
    ),
    yield* planLabels(),
  );
});

it.effect("reads the Build plan ID column", () =>
  Effect.gen(function* labels() {
    const found = yield* planLabels();

    assert.isTrue(found.has("I-00"));
    assert.isTrue(found.has("I-43"));
    assert.isFalse(found.has("I-99"));
  }).pipe(Effect.provide(BunServices.layer)),
);

it.effect.each(["untagged", "unverified-cite", "unlisted-label"] as const)(
  "reports one %s finding for its fixture",
  (rule) =>
    Effect.gen(function* fixture() {
      const found = yield* checkFixture(rule);

      assert.deepStrictEqual(
        found.map((finding) => [finding.line, finding.rule]),
        [[5, rule]],
      );
    }).pipe(Effect.provide(BunServices.layer)),
);

it.effect("passes a valid runbook", () =>
  Effect.gen(function* valid() {
    const runbook = [
      header,
      "| 1 | `bun install` | installs | verified | PR #12 proof 3 |",
      "| 2 | `bun install` | installs | verified | commit 013dea6 |",
      "| 3 | `bun run check` | exits 0 | unproven | I-00 I-43 |",
      "| 4 | none | a recorded fact | note | |",
    ].join("\n");

    assert.deepStrictEqual(checkRunbook(runbook, yield* planLabels()), []);
  }).pipe(Effect.provide(BunServices.layer)),
);

it("ignores tables outside a section and rows of another width", () => {
  const runbook = ["| a | b | c | d | e |", "", "## S", "", "| a | b | c |"].join("\n");

  assert.deepStrictEqual(checkRunbook(runbook, new Set()), []);
});

it("fails an unproven row that names no label", () => {
  const found = checkRunbook(`${header}\n| 1 | x | y | unproven | none |`, new Set(["I-00"]));

  assert.deepStrictEqual(
    found.map((finding) => finding.rule),
    ["unlisted-label"],
  );
});
