import { BunServices } from "@effect/platform-bun";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { DesignMdParseError, generate, generateFrom } from "./generate.ts";

/**
 * The directory of this test, the repository root and the fixtures beside it.
 */
const here = import.meta.dirname;

describe("design-md generator", () => {
  it.effect("generates the checked-in expected file from the fixture theme", () =>
    Effect.gen(function* test() {
      const fs = yield* FileSystem.FileSystem;
      const actual = yield* generateFrom(`${here}/fixtures/theme.css`);

      assert.strictEqual(actual, yield* fs.readFileString(`${here}/fixtures/expected.DESIGN.md`));
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("fails a stylesheet that does not parse, naming the file and line", () =>
    Effect.gen(function* test() {
      const fs = yield* FileSystem.FileSystem;
      const error = yield* Effect.flip(
        generate(
          "broken.stylesheet",
          yield* fs.readFileString(`${here}/fixtures/broken.stylesheet`),
        ),
      );

      assert.instanceOf(error, DesignMdParseError);
      assert.match(error.message, /^broken\.stylesheet:1: /u);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("matches the committed DESIGN.md for the packages/ui theme", () =>
    Effect.gen(function* test() {
      const fs = yield* FileSystem.FileSystem;
      const root = (yield* Path.Path).resolve(here, "../..");
      const fresh = yield* generateFrom(`${root}/packages/ui/src/styles/globals.css`);

      assert.strictEqual(
        yield* fs.readFileString(`${root}/DESIGN.md`),
        fresh,
        "DESIGN.md is stale; run bun run design:md",
      );
    }).pipe(Effect.provide(BunServices.layer)),
  );
});
