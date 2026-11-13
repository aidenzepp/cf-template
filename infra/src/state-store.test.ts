import { assert, describe, it } from "@effect/vitest";
import { PLACEHOLDER_STAGE } from "alchemy/Alchemist/Operations";
import { ConfigProvider, Effect, Option } from "effect";
import { selectStateStore } from "../alchemy.run.ts";

/**
 * Select the state store for `stage` against a config provider holding `env`.
 *
 * @param stage - The raw stage.
 * @param env - The environment values.
 * @returns The selection effect with the provider applied.
 */
const selectWith = (stage: string, env: Record<string, string>) =>
  selectStateStore(stage).pipe(
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
  );

describe("state store selection", () => {
  it.effect("builds the project store for Alchemy's placeholder stage with STACK_NAME pinned", () =>
    Effect.gen(function* pinned() {
      const worker = yield* selectWith(PLACEHOLDER_STAGE, { STACK_NAME: "example-stack" });

      assert.deepStrictEqual(worker, Option.some("example-stack-state"));
    }),
  );

  it.effect("derives the stack name for the placeholder stage when STACK_NAME is unset", () =>
    Effect.gen(function* derived() {
      const worker = yield* selectWith(PLACEHOLDER_STAGE, {
        GITHUB_EVENT_NAME: "workflow_dispatch",
        GITHUB_REPOSITORY: "acme/from-github",
      });

      assert.deepStrictEqual(worker, Option.some("from-github-state"));
    }),
  );

  it.effect("still decodes a real stage and rejects an invalid one", () =>
    Effect.gen(function* invalid() {
      const failure = yield* Effect.flip(selectWith("nonsense", { STACK_NAME: "example-stack" }));

      assert.strictEqual(failure._tag, "SchemaError");
    }),
  );

  it.effect("keeps the project store for prod and local state for a test stage", () =>
    Effect.gen(function* real() {
      const prod = yield* selectWith("prod", { CI: "true", STACK_NAME: "example-stack" });
      const test = yield* selectWith("test-abc", {});

      assert.deepStrictEqual(prod, Option.some("example-stack-state"));
      assert.isTrue(Option.isNone(test));
    }),
  );
});
