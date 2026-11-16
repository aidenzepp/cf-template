import { assert, describe, it } from "@effect/vitest";
import { CLOUD_STAGE } from "../stages.ts";
import { usesProjectState } from "./state-selection.ts";

describe("state selection", () => {
  it.each(["prod", "staging-12", CLOUD_STAGE])("keeps %s in the project state store", (stage) => {
    assert.isTrue(usesProjectState(stage));
  });

  it.each(["test-i05", "test-my-slug", "dev"])("keeps %s on local state", (stage) => {
    assert.isFalse(usesProjectState(stage));
  });
});
