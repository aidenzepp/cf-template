import { assert, describe, it } from "@effect/vitest";
import { ConfigProvider, Effect, Exit } from "effect";
import type { StageName } from "../stages.ts";
import { publicOrigin } from "./origin.ts";

/**
 * Compute the origin of a stage from fake values and one unrelated variable, so a schema that
 * reads the whole environment fails.
 */
const originOf = (stage: StageName, values: Record<string, string>) =>
  publicOrigin({ stack: "stack", stage }).pipe(
    Effect.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          CLOUDFLARE_WORKERS_SUBDOMAIN: "acme",
          UNRELATED: "present",
          ...values,
        }),
      ),
    ),
  );

describe("publicOrigin", () => {
  it.effect.each<readonly [string, StageName, Record<string, string>, string]>([
    [
      "prod with a hostname",
      "prod",
      { CUSTOM_DOMAIN: "app.example.com" },
      "https://app.example.com",
    ],
    [
      "prod on workers-dev",
      "prod",
      { CUSTOM_DOMAIN: "workers-dev" },
      "https://stack-web-prod.acme.workers.dev",
    ],
    ["staging", "staging-3", {}, "https://stack-web-staging-3.acme.workers.dev"],
    ["test slug", "test-i19", {}, "https://stack-web-test-i19.acme.workers.dev"],
    ["local", "dev", {}, "http://localhost:3000"],
    [
      "test with a hostname",
      "test-i26",
      { CUSTOM_DOMAIN: "app.example.com" },
      "https://app.example.com",
    ],
    [
      "test on workers-dev",
      "test-i26",
      { CUSTOM_DOMAIN: "workers-dev" },
      "https://stack-web-test-i26.acme.workers.dev",
    ],
  ])("derives the origin of %s", ([, stage, values, expected]) =>
    Effect.gen(function* derives() {
      assert.strictEqual(yield* originOf(stage, values), expected);
    }),
  );

  it.effect("fails decode on prod without CUSTOM_DOMAIN", () =>
    Effect.gen(function* missing() {
      const error = yield* Effect.flip(originOf("prod", {}));

      assert.include(String(error), "CUSTOM_DOMAIN");
    }),
  );

  it.effect.each(["Example.com", "example.com:8443"])(
    "fails the hostname check on prod with CUSTOM_DOMAIN %s",
    (value) =>
      Effect.gen(function* invalid() {
        // Both values would pass `PublicOrigin` once interpolated, so only `Hostname` refuses them.
        const error = yield* Effect.flip(originOf("prod", { CUSTOM_DOMAIN: value }));

        assert.include(String(error), "CUSTOM_DOMAIN");
        assert.include(String(error), "Expected a string matching the RegExp ^[a-z0-9]");
      }),
  );

  it.effect("fails on a cloud stage without CLOUDFLARE_WORKERS_SUBDOMAIN, naming it", () =>
    Effect.gen(function* missing() {
      const error = yield* Effect.flip(
        publicOrigin({ stack: "stack", stage: "staging-3" }).pipe(
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
        ),
      );

      assert.include(String(error), "CLOUDFLARE_WORKERS_SUBDOMAIN");
      assert.include(String(error), "workers.dev subdomain");
    }),
  );

  it.effect.each<readonly [StageName, string]>([
    ["staging-3", "app.example.com"],
    ["staging-3", "workers-dev"],
    ["dev", "app.example.com"],
  ])("rejects CUSTOM_DOMAIN on %s", ([stage, value]) =>
    Effect.gen(function* rejected() {
      const exit = yield* Effect.exit(originOf(stage, { CUSTOM_DOMAIN: value }));

      assert.isTrue(Exit.isFailure(exit));
    }),
  );

  it.effect("fails on a test stage whose CUSTOM_DOMAIN is not a hostname", () =>
    Effect.gen(function* invalid() {
      const error = yield* Effect.flip(originOf("test-i26", { CUSTOM_DOMAIN: "Example.com" }));

      assert.include(String(error), "CUSTOM_DOMAIN");
    }),
  );
});
