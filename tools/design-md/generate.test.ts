import { BunServices } from "@effect/platform-bun";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import {
  DesignMdGuidanceError,
  DesignMdParseError,
  DesignMdResolveError,
  generate,
  generateFrom,
} from "./generate.ts";

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

      const fresh = yield* generateFrom(
        `${root}/packages/ui/src/styles/globals.css`,
        `${root}/tools/design-md/guidance.md`,
      );

      assert.strictEqual(
        yield* fs.readFileString(`${root}/DESIGN.md`),
        fresh,
        "DESIGN.md is stale; run bun run design:md",
      );
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("fails a guidance file that repeats a generated heading", () =>
    Effect.gen(function* test() {
      const error = yield* Effect.flip(
        generateFrom(`${here}/fixtures/theme.css`, `${here}/fixtures/guidance-repeats-heading.md`),
      );

      assert.instanceOf(error, DesignMdGuidanceError);
      assert.match(error.message, /"## Colors"/u);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("resolves a radius step multiplied from --radius into a plain dimension", () =>
    Effect.gen(function* test() {
      const css = [
        ":root { --radius: 0.625rem; }",
        "@theme inline {",
        "  --radius-sm: calc(var(--radius) * 0.6);",
        "  --radius-xl: calc(1.4 * var(--radius));",
        "  --radius-half: calc(var(--radius) / 2);",
        "}",
      ].join("\n");

      const text = yield* generate("radius.css", css);

      assert.include(text, 'rounded:\n  sm: "0.375rem"\n  xl: "0.875rem"\n  half: "0.3125rem"\n');
    }),
  );

  it.effect("fails a radius step it cannot resolve, naming the token and the expression", () =>
    Effect.gen(function* test() {
      const css = [
        ":root { --radius: 0.625rem; }",
        "@theme inline { --radius-sm: calc(var(--other) + 1px); }",
      ].join("\n");

      const error = yield* Effect.flip(generate("radius.css", css));

      assert.instanceOf(error, DesignMdResolveError);
      assert.match(error.message, /^--radius-sm: cannot resolve "calc\(var\(--other\) \+ 1px\)"/u);
    }),
  );
});
