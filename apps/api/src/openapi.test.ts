import { assert, describe, it } from "@effect/vitest";
import { OpenApi } from "effect/http-api";
import { Api } from "@workspace/contract/api/api";
import { AUTH_BASE_PATH } from "@workspace/auth/contract";

describe("Api OpenAPI document", () => {
  it("lists no path under the auth base path", () => {
    const paths = Object.keys(OpenApi.fromApi(Api).paths);

    assert.isAbove(paths.length, 0);
    assert.deepStrictEqual(
      paths.filter((path) => path.startsWith(AUTH_BASE_PATH)),
      [],
    );
  });
});
