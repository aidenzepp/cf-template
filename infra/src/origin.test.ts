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
  ])("derives the origin of %s", ([, stage, values, expected]) =>
    Effect.gen(function* derives() {
      assert.strictEqual(yield* originOf(stage, values), expected);
    }),
  );

  it.effect("fails decode on prod without CUSTOM_DOMAIN", () =>
    Effect.gen(function* missing() {
      assert.isTrue(Exit.isFailure(yield* Effect.exit(originOf("prod", {}))));
    }),
  );

  it.effect("fails decode on prod with an invalid CUSTOM_DOMAIN", () =>
    Effect.gen(function* invalid() {
      const exit = yield* Effect.exit(originOf("prod", { CUSTOM_DOMAIN: "https://example.com" }));

      assert.isTrue(Exit.isFailure(exit));
    }),
  );

  it.effect.each<readonly [StageName, string]>([
    ["staging-3", "app.example.com"],
    ["test-ci", "workers-dev"],
    ["dev", "app.example.com"],
  ])("rejects CUSTOM_DOMAIN on %s", ([stage, value]) =>
    Effect.gen(function* rejected() {
      const exit = yield* Effect.exit(originOf(stage, { CUSTOM_DOMAIN: value }));

      assert.isTrue(Exit.isFailure(exit));
    }),
  );
});
