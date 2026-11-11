import { assert, describe, it } from "@effect/vitest";
import { ConfigProvider, Effect, Exit, Option, Redacted } from "effect";
import { WorkersSubdomainMissing, interimPublicOrigin, providerCredentials } from "./auth.ts";

/**
 * Read the provider pairs from fake values and one unrelated variable, so a schema that reads the
 * whole environment fails.
 */
const readPairs = (values: Record<string, string>) =>
  providerCredentials.parse(ConfigProvider.fromUnknown({ UNRELATED: "present", ...values }));

describe("providerCredentials", () => {
  it.effect("omits a provider with neither credential", () =>
    Effect.gen(function* neither() {
      const pairs = yield* readPairs({});

      assert.isTrue(Option.isNone(pairs.github));
      assert.isTrue(Option.isNone(pairs.google));
    }),
  );

  it.effect("keeps a provider with both credentials", () =>
    Effect.gen(function* both() {
      const pairs = yield* readPairs({
        GITHUB_CLIENT_ID: "fake-id",
        GITHUB_CLIENT_SECRET: "fake-secret",
      });

      assert.isTrue(Option.isSome(pairs.github));
      assert.isTrue(Option.isNone(pairs.google));
      assert.strictEqual(Redacted.value(Option.getOrThrow(pairs.github).secret), "fake-secret");
    }),
  );

  it.effect("reads an empty string as absent", () =>
    Effect.gen(function* empty() {
      const pairs = yield* readPairs({ GITHUB_CLIENT_ID: "", GITHUB_CLIENT_SECRET: "" });

      assert.isTrue(Option.isNone(pairs.github));
    }),
  );

  it.effect.each<Record<string, string>>([
    { GITHUB_CLIENT_ID: "fake-id" },
    { GITHUB_CLIENT_SECRET: "fake-secret" },
    { GOOGLE_CLIENT_ID: "fake-id", GOOGLE_CLIENT_SECRET: "" },
  ])("fails decode when one credential of a pair is set alone: %o", (values) =>
    Effect.gen(function* half() {
      assert.isTrue(Exit.isFailure(yield* Effect.exit(readPairs(values))));
    }),
  );
});

describe("interimPublicOrigin", () => {
  it.effect("is the workers.dev address of the web Worker on a cloud stage", () =>
    Effect.gen(function* cloud() {
      const origin = yield* interimPublicOrigin({
        stack: "stack",
        stage: "test-i08",
        subdomain: Option.some("acme"),
      });

      assert.strictEqual(origin, "https://stack-web-test-i08.acme.workers.dev");
    }),
  );

  it.effect("is the local dev server on the local kind", () =>
    Effect.gen(function* local() {
      const origin = yield* interimPublicOrigin({
        stack: "stack",
        stage: "dev",
        subdomain: Option.none(),
      });

      assert.strictEqual(origin, "http://localhost:3000");
    }),
  );

  it.effect("fails on a cloud stage without a subdomain", () =>
    Effect.gen(function* missing() {
      const error = yield* Effect.flip(
        interimPublicOrigin({ stack: "stack", stage: "prod", subdomain: Option.none() }),
      );

      assert.instanceOf(error, WorkersSubdomainMissing);
    }),
  );
});
