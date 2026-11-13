import { assert, describe, it } from "@effect/vitest";
import { ConfigProvider, Effect, Exit, Redacted } from "effect";
import type { StageName } from "../stages.ts";
import { oauthProxyBindings } from "./auth.ts";

/**
 * `prod`'s origin and a preview's own origin.
 */
const PROD = "https://app.example.test";

const PREVIEW = "https://stack-web-staging-3.acme.workers.dev";

/**
 * Compute the bindings of one stage from fake deployer values and one unrelated variable.
 */
const bindingsFor = (stage: StageName, origin: string, values: Record<string, string>) =>
  oauthProxyBindings(stage, origin).pipe(
    Effect.provide(
      ConfigProvider.layer(ConfigProvider.fromUnknown({ UNRELATED: "present", ...values })),
    ),
  );

/**
 * Read the bindings as plain text, so a test compares the redacted secret by value.
 */
const reveal = (bindings: Record<string, string | Redacted.Redacted>) =>
  Object.fromEntries(
    Object.entries(bindings).map(([key, value]) => [
      key,
      Redacted.isRedacted(value) ? Redacted.value(value) : value,
    ]),
  );

describe("oauthProxyBindings", () => {
  it.effect("binds prod's own origin when the secret is set", () =>
    Effect.gen(function* prodWithSecret() {
      const bindings = yield* bindingsFor("prod", PROD, {
        OAUTH_PROXY_SECRET: "proxy",
        PROD_ORIGIN: "https://other.example.test",
      });

      assert.deepStrictEqual(reveal(bindings), {
        OAUTH_PROXY_PRODUCTION_URL: PROD,
        OAUTH_PROXY_SECRET: "proxy",
      });
    }),
  );

  it.effect("binds PROD_ORIGIN on a preview with both values set", () =>
    Effect.gen(function* previewWithBoth() {
      const bindings = yield* bindingsFor("staging-3", PREVIEW, {
        OAUTH_PROXY_SECRET: "proxy",
        PROD_ORIGIN: PROD,
      });

      assert.deepStrictEqual(reveal(bindings), {
        OAUTH_PROXY_PRODUCTION_URL: PROD,
        OAUTH_PROXY_SECRET: "proxy",
      });
    }),
  );

  it.effect("binds nothing on a preview without PROD_ORIGIN", () =>
    Effect.gen(function* previewWithoutOrigin() {
      const bindings = yield* bindingsFor("staging-3", PREVIEW, { OAUTH_PROXY_SECRET: "proxy" });

      assert.deepStrictEqual(bindings, {});
    }),
  );

  it.effect("fails on a preview with a malformed PROD_ORIGIN", () =>
    Effect.gen(function* previewWithBadOrigin() {
      const exit = yield* Effect.exit(
        bindingsFor("staging-3", PREVIEW, {
          OAUTH_PROXY_SECRET: "proxy",
          PROD_ORIGIN: "not an origin",
        }),
      );

      assert.isTrue(Exit.isFailure(exit));
    }),
  );

  it.effect("binds nothing on a test stage with both values set", () =>
    Effect.gen(function* testStage() {
      const bindings = yield* bindingsFor("test-ci", PREVIEW, {
        OAUTH_PROXY_SECRET: "proxy",
        PROD_ORIGIN: PROD,
      });

      assert.deepStrictEqual(bindings, {});
    }),
  );
});
