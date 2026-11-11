import { assert, describe, it } from "@effect/vitest";
import { ConfigProvider, Effect } from "effect";
import { ProdStageRefused, decodeStage } from "../alchemy.run.ts";

/**
 * Decode `stage` against a config provider holding `env`.
 *
 * @param stage - The raw stage.
 * @param env - The environment values.
 * @returns The decode effect with the provider applied.
 */
const decodeWith = (stage: string, env: Record<string, string>) =>
  decodeStage(stage).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))));

describe("prod stage refusal", () => {
  it.effect("refuses prod when CI is absent", () =>
    Effect.gen(function* absent() {
      const failure = yield* Effect.flip(decodeWith("prod", {}));

      assert.instanceOf(failure, ProdStageRefused);
      assert.strictEqual(failure.stage, "prod");
    }),
  );

  it.effect("refuses prod when CI is false", () =>
    Effect.gen(function* disabled() {
      const failure = yield* Effect.flip(decodeWith("prod", { CI: "false" }));

      assert.instanceOf(failure, ProdStageRefused);
    }),
  );

  it.effect("accepts prod when CI is true", () =>
    Effect.gen(function* enabled() {
      const stage = yield* decodeWith("prod", { CI: "true" });

      assert.strictEqual(stage, "prod");
    }),
  );

  it.effect("accepts a test stage without CI", () =>
    Effect.gen(function* test() {
      const stage = yield* decodeWith("test-i05", {});

      assert.strictEqual(stage, "test-i05");
    }),
  );
});
