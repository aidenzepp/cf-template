import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { EmailTokenError, oklchToHex } from "./color.ts";

describe("oklch to hex", () => {
  it.effect("reproduces the hex Tailwind publishes for red-600, red-400 and blue-700", () =>
    Effect.gen(function* test() {
      assert.strictEqual(yield* oklchToHex("oklch(0.577 0.245 27.325)"), "#e7000b");
      assert.strictEqual(yield* oklchToHex("oklch(0.704 0.191 22.216)"), "#ff6467");
      assert.strictEqual(yield* oklchToHex("oklch(0.488 0.243 264.376)"), "#1447e6");
    }),
  );

  it.effect("converts the neutral ramp the theme uses", () =>
    Effect.gen(function* test() {
      assert.strictEqual(yield* oklchToHex("oklch(1 0 0)"), "#ffffff");
      assert.strictEqual(yield* oklchToHex("oklch(0.145 0 0)"), "#0a0a0a");
      assert.strictEqual(yield* oklchToHex("oklch(0.205 0 0)"), "#171717");
      assert.strictEqual(yield* oklchToHex("oklch(0.922 0 0)"), "#e5e5e5");
    }),
  );

  it.effect("composites an alpha color over its surface and pins the hex", () =>
    Effect.gen(function* test() {
      assert.strictEqual(yield* oklchToHex("oklch(1 0 0 / 10%)", "#0a0a0a"), "#232323");
      assert.strictEqual(yield* oklchToHex("oklch(1 0 0 / 15%)", "#0a0a0a"), "#2f2f2f");
      assert.strictEqual(yield* oklchToHex("oklch(1 0 0 / 0.1)", "#0a0a0a"), "#232323");
      assert.strictEqual(yield* oklchToHex("oklch(1 0 0 / 10%)", "#171717"), "#2e2e2e");
    }),
  );

  it.effect("ignores the surface of an opaque color", () =>
    Effect.gen(function* test() {
      assert.strictEqual(yield* oklchToHex("oklch(0.145 0 0)", "#ff0000"), "#0a0a0a");
    }),
  );

  it.effect("fails an alpha color that has no opaque surface", () =>
    Effect.gen(function* test() {
      const missing = yield* Effect.flip(oklchToHex("oklch(1 0 0 / 10%)"));
      const notHex = yield* Effect.flip(oklchToHex("oklch(1 0 0 / 10%)", "oklch(0.145 0 0)"));

      assert.instanceOf(missing, EmailTokenError);
      assert.match(missing.message, /needs an opaque #rrggbb surface to sit on; got none/u);
      assert.instanceOf(notHex, EmailTokenError);
      assert.match(notHex.message, /got "oklch\(0\.145 0 0\)"/u);
    }),
  );

  it.effect("fails a color it cannot read, naming the value", () =>
    Effect.gen(function* test() {
      for (const value of ["oklch(bad)", "#e7000b", "rgb(231 0 11)", "oklch(0.5 0.2)"]) {
        const error = yield* Effect.flip(oklchToHex(value));

        assert.instanceOf(error, EmailTokenError);
        assert.strictEqual(error._tag, "EmailTokenError");
        assert.include(error.message, `cannot read "${value}"`);
      }
    }),
  );
});
