import { assert, describe, it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer, Ref } from "effect";
import { ForeignRateLimitRules, RateLimitEntrypoint } from "./rate-limit-owner.ts";
import { guardedDomain } from "./web.ts";

const zone = { id: "zone-1", name: "example.test" };

/**
 * Run `guardedDomain` for `stage` with `env` as the environment, against a fake entrypoint that
 * holds the foreign rule `dash-1` and counts its reads.
 *
 * @param stage - The stage name.
 * @param env - The environment values.
 * @returns The exit of the program and how many times the fake was read.
 */
const run = (stage: "prod" | `test-${string}`, env: Record<string, string>) =>
  Effect.gen(function* guard() {
    const reads = yield* Ref.make(0);

    const entrypoint = Layer.succeed(RateLimitEntrypoint, {
      read: () =>
        Ref.update(reads, (count) => count + 1).pipe(
          Effect.as({ rules: [{ id: "dash-1", ref: undefined }], zone }),
        ),
    });

    const exit = yield* guardedDomain({ stack: "app", stage }, entrypoint).pipe(
      Effect.exit,
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
    );

    return { exit, reads: yield* Ref.get(reads) };
  });

describe("guardedDomain", () => {
  it.effect("refuses a hostname stage whose zone holds a foreign rule, naming the variable", () =>
    Effect.gen(function* refused() {
      const { exit, reads } = yield* run("test-x", {
        STAGES_TEST_CUSTOM_DOMAIN: "app.example.test",
      });

      assert.strictEqual(reads, 1);
      assert.isTrue(exit._tag === "Failure");

      const failure = yield* Effect.flip(Effect.suspend(() => exit));

      assert.instanceOf(failure, ForeignRateLimitRules);
      assert.include(failure.message, "STAGES_TEST_CUSTOM_DOMAIN");
    }),
  );

  it.effect("does not read the entrypoint on the workers.dev default", () =>
    Effect.gen(function* skipped() {
      const { exit, reads } = yield* run("test-x", {});

      assert.strictEqual(reads, 0);
      assert.isTrue(exit._tag === "Success");
    }),
  );
});
