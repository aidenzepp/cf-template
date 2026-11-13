import { assert, describe, it } from "@effect/vitest";
import { Config, Effect } from "effect";

describe("the root test environment", () => {
  it.effect("sets ALCHEMY_TEST_DEV so a default project never deploys", () =>
    Effect.gen(function* readSetting() {
      const value = yield* Config.String("ALCHEMY_TEST_DEV");
      assert.strictEqual(value, "1");
    }),
  );
});
