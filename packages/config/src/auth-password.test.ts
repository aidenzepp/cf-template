import { scryptSync } from "node:crypto";
import { assert, describe, it } from "@effect/vitest";
import { Config, ConfigProvider, Effect, Exit, Option, Schema } from "effect";
import { AUTH_PASSWORD_SCRYPT, scryptMaxmem } from "./auth-password.ts";
import type { ScryptCost } from "./auth-password.ts";

/**
 * Read the knob from a provider that holds an unrelated variable and, when given, the knob.
 *
 * @param raw - The knob's JSON text, or `undefined` to leave it unset.
 * @returns The exit of the knob's `Config`.
 */
const read = (raw?: string) => {
  const env =
    raw === undefined ? { UNRELATED: "value" } : { AUTH_PASSWORD_SCRYPT: raw, UNRELATED: "value" };

  return Effect.exit(
    AUTH_PASSWORD_SCRYPT.config.pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
    ),
  );
};

/**
 * A scrypt call node:crypto rejected.
 */
class DeriveFailed extends Schema.TaggedError<DeriveFailed, { readonly brand: unique symbol }>()(
  "DeriveFailed",
  {
    cause: Schema.Defect(),
  },
) {}

/**
 * Run one scrypt call with the `maxmem` this project derives, so a rejected parameter set fails.
 *
 * @param params - The cost parameters.
 * @returns The effect that settles with the derived key.
 */
const derive = (params: ScryptCost) =>
  // The one node:crypto call in this file, to prove Node accepts the derived `maxmem`.
  Effect.try({
    catch: (cause) => new DeriveFailed({ cause }),
    try: () =>
      scryptSync("password", "salt", 8, {
        N: 2 ** params.ln,
        maxmem: scryptMaxmem(params),
        p: params.p,
        r: params.r,
      }),
  });

describe("AUTH_PASSWORD_SCRYPT", () => {
  it.effect("is the default when unset", () =>
    Effect.gen(function* unset() {
      assert.deepStrictEqual(yield* Effect.flatten(read()), { ln: 15, p: 3, r: 8 });
    }),
  );

  it.effect("decodes the JSON text of the default", () =>
    Effect.gen(function* decodes() {
      const exit = yield* read('{"ln":15,"r":8,"p":3}');

      assert.deepStrictEqual(Exit.isSuccess(exit) ? exit.value : undefined, {
        ln: 15,
        p: 3,
        r: 8,
      });
    }),
  );

  it.effect("fails malformed JSON through the Config error channel", () =>
    Effect.gen(function* malformed() {
      const error = Exit.findErrorOption(yield* read("{not json"));

      assert.isTrue(Option.isSome(error) && error.value instanceof Config.ConfigError);
    }),
  );

  it.effect.each([
    '{"ln":9,"r":8,"p":3}',
    '{"ln":21,"r":8,"p":3}',
    '{"ln":15,"r":0,"p":3}',
    '{"ln":15,"r":33,"p":3}',
    '{"ln":15,"r":8,"p":0}',
    '{"ln":15,"r":8,"p":17}',
  ])("rejects %s, outside the bounds", (raw) =>
    Effect.gen(function* bounds() {
      assert.isTrue(Exit.isFailure(yield* read(raw)));
    }),
  );

  it.effect("rejects 12/10/16 by the memory floor although it passes the work floor", () =>
    Effect.gen(function* memoryFloor() {
      // 128 x 4096 x 10 = 5,242,880 bytes; 4096 x 10 x 16 = 655,360.
      const exit = yield* read('{"ln":12,"r":10,"p":16}');

      assert.isTrue(Exit.isFailure(exit));
      assert.include(String(exit), "32 MiB");
    }),
  );

  it.effect("rejects 14/8/1, whose work 131,072 is under the work floor", () =>
    Effect.gen(function* workFloor() {
      // Its memory, 128 x 16384 x 8 = 16 MiB, is under the memory floor as well: any pair that
      // clears the memory floor has 2^ln x r >= 2^18, so the work floor never fails alone.
      const exit = yield* read('{"ln":14,"r":8,"p":1}');

      assert.isTrue(Exit.isFailure(exit));
      assert.include(String(exit), "32 MiB");
    }),
  );

  it.effect("rejects 20/8/1 over the ceiling", () =>
    Effect.gen(function* ceiling() {
      const exit = yield* read('{"ln":20,"r":8,"p":1}');

      assert.isTrue(Exit.isFailure(exit));
      assert.include(String(exit), "64 MiB");
    }),
  );

  it.effect("rejects 19/1/16 over the work ceiling although it fits the memory ceiling", () =>
    Effect.gen(function* workCeiling() {
      // 128 x 2^19 x 1 = 64 MiB; 2^19 x 1 x 16 = 2^23, twice the 2^22 ceiling.
      const exit = yield* read('{"ln":19,"r":1,"p":16}');

      assert.isTrue(Exit.isFailure(exit));
      assert.include(String(exit), "4194304");
    }),
  );

  it.effect("accepts 16/8/8 exactly at both ceilings", () =>
    Effect.gen(function* atCeiling() {
      // 128 x 2^16 x 8 = 64 MiB; 2^16 x 8 x 8 = 2^22.
      assert.isTrue(Exit.isSuccess(yield* read('{"ln":16,"r":8,"p":8}')));
    }),
  );

  it.effect.each([
    { ln: 15, p: 3, r: 8 },
    { ln: 15, p: 1, r: 16 },
  ])("derives a maxmem node:crypto accepts for %j", (params) =>
    Effect.gen(function* maxmem() {
      assert.strictEqual((yield* derive(params)).length, 8);
    }),
  );
});
