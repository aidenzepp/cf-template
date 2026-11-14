import { assert, describe, it } from "@effect/vitest";
import { declaresGuardReceiver } from "./guard-plan.ts";

describe("declaresGuardReceiver", () => {
  it("declares the receiver on prod, staging and local stages", () => {
    for (const stage of ["prod", "staging-1", "dev"] as const) {
      assert.isTrue(declaresGuardReceiver(stage));
    }
  });

  it("declares no receiver on the test kind", () => {
    for (const stage of ["test-ci", "test-abc"] as const) {
      assert.isFalse(declaresGuardReceiver(stage));
    }
  });
});
