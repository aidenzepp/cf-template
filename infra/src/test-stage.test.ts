import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { TestStageRefused, decideTestStage } from "./test-stage.ts";

describe("test-stage guard", () => {
  for (const stage of ["prod", "staging-1", "test-ci", "dev", "test-", "Test-x", "test-a_b", ""]) {
    it.effect(`refuses stage ${JSON.stringify(stage)}`, () =>
      Effect.gen(function* refused() {
        const failure = yield* Effect.flip(decideTestStage("deploy", stage));

        assert.instanceOf(failure, TestStageRefused);
      }),
    );
  }

  it.effect("refuses an unknown phase", () =>
    Effect.gen(function* refused() {
      const failure = yield* Effect.flip(decideTestStage("plan", "test-i05"));

      assert.instanceOf(failure, TestStageRefused);
    }),
  );

  for (const phase of ["deploy", "destroy"]) {
    it.effect(`accepts ${phase} of test-i05`, () =>
      Effect.gen(function* accepted() {
        const decision = yield* decideTestStage(phase, "test-i05");

        assert.deepStrictEqual(decision, { phase, stage: "test-i05" });
      }),
    );
  }
});
