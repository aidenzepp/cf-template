import { assert, describe, it } from "@effect/vitest";
import { inMemoryState } from "alchemy/State";
import type { ResourceState } from "alchemy/State";
import { ConfigProvider, Effect, Redacted } from "effect";
import { emailKey } from "../../apps/auth/src/email-key.ts";
import { LogKeyRefused, keyFor, parseRequest, resolveTarget } from "./log-key.ts";

/**
 * The secret the fake state records for `test-abc`.
 */
const SECRET = "recorded-secret-0123456789abcdef";

/**
 * The persisted `Alchemy.Random` record of the email key secret.
 */
const recorded = {
  attr: { text: Redacted.make(SECRET) },
  bindings: [],
  downstream: [],
  fqn: "EmailKeySecret",
  instanceId: "i",
  logicalId: "EmailKeySecret",
  namespace: undefined,
  props: {},
  providerVersion: 1,
  resourceType: "Alchemy.Random",
  status: "created",
} satisfies ResourceState;

/**
 * Read a key from a store that holds `rows` under the stack the stack program names.
 */
const read = (rows: Record<string, ResourceState>, stage: string, email: string) =>
  keyFor(stage, email).pipe(Effect.provide(inMemoryState({ app: { "test-abc": rows } })));

describe("parseRequest", () => {
  it.effect("requires --stage and exactly one address", () =>
    Effect.gen(function* usage() {
      assert.instanceOf(yield* Effect.flip(parseRequest(["ada@example.test"])), LogKeyRefused);
      assert.instanceOf(yield* Effect.flip(parseRequest(["--stage", "x"])), LogKeyRefused);
      assert.instanceOf(
        yield* Effect.flip(parseRequest(["--stage", "x", "a", "b"])),
        LogKeyRefused,
      );

      assert.deepStrictEqual(yield* parseRequest(["ada@example.test", "--stage", "test-abc"]), {
        email: "ada@example.test",
        stage: "test-abc",
      });
    }),
  );
});

describe("resolveTarget", () => {
  it.effect("refuses prod unless CI=true, before any store is reached", () =>
    Effect.gen(function* refused() {
      const failure = yield* Effect.flip(
        resolveTarget("prod").pipe(
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
        ),
      );

      assert.instanceOf(failure, LogKeyRefused);
      assert.include(failure.message, "CI=true");
    }),
  );
});

describe("keyFor", () => {
  it.effect("hashes the normalized address under the recorded secret", () =>
    Effect.gen(function* hashed() {
      const key = yield* read({ EmailKeySecret: recorded }, "test-abc", "  Ada@Example.test");

      assert.strictEqual(key, yield* emailKey(Redacted.make(SECRET), "ada@example.test"));
      assert.notInclude(key, SECRET);
    }),
  );

  it.effect("refuses a stage whose state records no secret", () =>
    Effect.gen(function* absent() {
      const failure = yield* Effect.flip(read({}, "test-abc", "ada@example.test"));

      assert.instanceOf(failure, LogKeyRefused);
      assert.include(failure.message, "Deploy the stage first");
    }),
  );
});
