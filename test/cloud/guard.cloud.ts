import { assert, describe, it } from "@effect/vitest";
import { Config, Effect, Option } from "effect";

describe("the cloud environment", () => {
  it.effect("leaves ALCHEMY_TEST_DEV unset so the suite deploys", () =>
    Effect.gen(function* readSetting() {
      const value = yield* Config.String("ALCHEMY_TEST_DEV").pipe(Config.option);
      assert.isTrue(Option.isNone(value));
    }),
  );
});
