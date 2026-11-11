import { assert, describe, it } from "@effect/vitest";
import { ConfigProvider, Effect, Exit } from "effect";
import { AUTH_METHODS, decodeAuthMethods } from "./auth-methods.ts";

/**
 * Read `AUTH_METHODS` from a provider that also holds one unrelated variable, so a schema that
 * reads the whole environment fails.
 */
const read = (value: string) =>
  Effect.exit(
    AUTH_METHODS.parse(ConfigProvider.fromUnknown({ AUTH_METHODS: value, UNRELATED: "present" })),
  );

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

  it.effect("rejects a provider id the schema does not name", () =>
    Effect.gen(function* rejects() {
      const exit = yield* Effect.exit(decodeAuthMethods('{"providers":["gitlab"],"email":false}'));

      assert.isTrue(Exit.isFailure(exit));
    }),
  );
});

describe("AUTH_METHODS", () => {
  it.effect("decodes the bound JSON text beside an unrelated variable", () =>
    Effect.gen(function* decodes() {
      const exit = yield* read('{"email":true,"providers":["github","google"]}');

      assert.deepStrictEqual(exit, Exit.succeed({ email: true, providers: ["github", "google"] }));
    }),
  );

  it.effect("fails through the Config error channel when the binding is missing", () =>
    Effect.gen(function* missing() {
      const exit = yield* Effect.exit(
        AUTH_METHODS.parse(ConfigProvider.fromUnknown({ UNRELATED: "present" })),
      );

      assert.isTrue(Exit.isFailure(exit));
    }),
  );

  it.effect("fails when the bound text is not JSON of the declared shape", () =>
    Effect.gen(function* rejects() {
      assert.isTrue(Exit.isFailure(yield* read("not json")));
      assert.isTrue(Exit.isFailure(yield* read('{"email":false}')));
    }),
  );
});
