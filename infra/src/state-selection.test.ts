import { assert, describe, it } from "@effect/vitest";
import { usesProjectState } from "../alchemy.run.ts";

describe("state selection", () => {
  for (const stage of ["prod", "staging-12", "test-ci"]) {
    it(`keeps ${stage} in the project state store`, () => {
      assert.isTrue(usesProjectState(stage));
    });
  }

  for (const stage of ["test-i05", "test-my-slug", "dev"]) {
    it(`keeps ${stage} on local state`, () => {
      assert.isFalse(usesProjectState(stage));
    });
  }
});
