import { assert, describe, it } from "@effect/vitest";
import { DOCS_PATH, LLMS_PATH, OPENAPI_PATH } from "@workspace/contract/api/docs-paths";
import { forwardTarget } from "./forward.ts";
import { FORWARD_PREFIXES } from "./forward-prefixes.ts";

describe("forwardTarget", () => {
  it("sends every documentation path of the contract to api", () => {
    for (const path of [OPENAPI_PATH, DOCS_PATH, LLMS_PATH]) {
      assert.strictEqual(forwardTarget(path), "API");
    }
  });

  it("forwards the contract's llms.txt path by name", () => {
    assert.include(FORWARD_PREFIXES, LLMS_PATH);
  });

  it("matches /llms.txt exactly, so a longer path stays with TanStack", () => {
    assert.isUndefined(forwardTarget("/llms.txt/more"));
    assert.isUndefined(forwardTarget("/llms.txtx"));
    assert.isUndefined(forwardTarget("/"));
  });

  it("keeps the prefix forwards for api and auth", () => {
    assert.strictEqual(forwardTarget("/api/session"), "API");
    assert.strictEqual(forwardTarget("/auth/sign-in"), "AUTH");
  });
});
