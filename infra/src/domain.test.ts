import { assert, describe, it } from "@effect/vitest";
import { ConfigProvider, Effect } from "effect";
import { domainFor, wafRateLimitRule } from "./domain.ts";

/**
 * Compute the domain of `prod` from a fake `CUSTOM_DOMAIN` and one unrelated variable.
 */
const domainOf = (value: string) =>
  domainFor("prod").pipe(
    Effect.provide(
      ConfigProvider.layer(ConfigProvider.fromUnknown({ CUSTOM_DOMAIN: value, UNRELATED: "x" })),
    ),
  );

describe("domainFor", () => {
  it.effect("keeps workers.dev on and detaches with an explicit null", () =>
    Effect.gen(function* detach() {
      assert.deepStrictEqual(yield* domainOf("workers-dev"), {
        domain: null,
        kind: "workers-dev",
        workersDev: { enabled: true, previewsEnabled: false },
      });
    }),
  );

  it.effect("attaches a hostname and turns workers.dev off", () =>
    Effect.gen(function* attach() {
      assert.deepStrictEqual(yield* domainOf("example.test"), {
        domain: "example.test",
        hostname: "example.test",
        kind: "hostname",
        workersDev: false,
      });
    }),
  );

  it.effect("ignores CUSTOM_DOMAIN's absence on a test stage", () =>
    Effect.gen(function* absent() {
      const config = yield* domainFor("test-i26").pipe(
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
      );

      assert.strictEqual(config.kind, "workers-dev");
    }),
  );
});

describe("wafRateLimitRule", () => {
  it("carries the expression, 50 per 10 s, block and a 10 s timeout", () => {
    const ruleset = wafRateLimitRule("example.test");
    const [rule] = ruleset.rules;

    assert.strictEqual(ruleset.phase, "http_ratelimit");
    assert.strictEqual(ruleset.rules.length, 1);
    assert.strictEqual(rule.expression, 'not starts_with(http.request.uri.path, "/assets/")');
    assert.strictEqual(rule.action, "block");
    assert.deepStrictEqual(rule.ratelimit, {
      characteristics: ["ip.src"],
      mitigationTimeout: 10,
      period: 10,
      requestsPerPeriod: 50,
    });
  });
});
