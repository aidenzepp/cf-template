import { assert, describe, it } from "@effect/vitest";
import { ConfigProvider, Effect, Option } from "effect";
import { d1LocationHint } from "./d1-location.ts";

/**
 * Read the knob from a config provider holding `env`.
 *
 * @param env - The environment values.
 * @returns The knob's tier (b) result.
 */
const readWith = (env: Record<string, string>) =>
  d1LocationHint.pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))));

describe("D1LocationHintKnob", () => {
  it.effect("is none when unset", () =>
    Effect.gen(function* unset() {
      assert.isTrue(Option.isNone(yield* readWith({})));
    }),
  );

  it.effect("is some for a valid hint", () =>
    Effect.gen(function* valid() {
      const hint = yield* readWith({ D1_PROD_LOCATION_HINT: "weur" });

      assert.deepStrictEqual(hint, Option.some("weur"));
    }),
  );

  it.effect("fails for an unknown hint", () =>
    Effect.gen(function* invalid() {
      const failure = yield* Effect.flip(readWith({ D1_PROD_LOCATION_HINT: "mars" }));

      assert.strictEqual(failure._tag, "ConfigError");
    }),
  );
});
