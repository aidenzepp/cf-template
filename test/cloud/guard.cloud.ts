import { assert, describe, it } from "@effect/vitest";

describe("the cloud environment", () => {
  it("leaves ALCHEMY_TEST_DEV unset so the suite deploys", () => {
    assert.strictEqual(process.env.ALCHEMY_TEST_DEV, undefined);
  });
});
