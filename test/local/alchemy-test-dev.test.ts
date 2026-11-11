import { assert, describe, it } from "@effect/vitest";

describe("the root test environment", () => {
  it("sets ALCHEMY_TEST_DEV so a default project never deploys", () => {
    assert.strictEqual(process.env.ALCHEMY_TEST_DEV, "1");
  });
});
