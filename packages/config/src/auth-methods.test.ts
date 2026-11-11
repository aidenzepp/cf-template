import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { decodeAuthMethods } from "./auth-methods.ts";

describe("decodeAuthMethods", () => {
  it.effect("decodes the JSON infra binds", () =>
    Effect.gen(function* decodes() {
      const methods = yield* decodeAuthMethods('{"providers":[],"email":false}');

      assert.deepStrictEqual(methods, { email: false, providers: [] });
    }),
  );

  it.effect("rejects text that is not the declared shape", () =>
    Effect.gen(function* rejects() {
      assert.isTrue(Exit.isFailure(yield* Effect.exit(decodeAuthMethods('{"providers":[]}'))));
      assert.isTrue(Exit.isFailure(yield* Effect.exit(decodeAuthMethods("not json"))));
    }),
  );
});
