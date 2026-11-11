import { assert, describe, it } from "@effect/vitest";
import {
  WAF_RATE_LIMIT_MITIGATION_SECONDS,
  WAF_RATE_LIMIT_PERIOD_SECONDS,
  WAF_RATE_LIMIT_REQUESTS,
} from "@workspace/config/waf";
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

  it.effect("attaches the hostname on a test stage that sets STAGES_TEST_CUSTOM_DOMAIN", () =>
    Effect.gen(function* testHostname() {
      const config = yield* domainFor("test-i26").pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({ STAGES_TEST_CUSTOM_DOMAIN: "example.test" }),
          ),
        ),
      );

      assert.strictEqual(config.domain, "example.test");
      assert.strictEqual(config.workersDev, false);
    }),
  );

  it.effect("stays on workers-dev on a test stage with only CUSTOM_DOMAIN set", () =>
    Effect.gen(function* prodKeyOnly() {
      const config = yield* domainFor("test-ci").pipe(
        Effect.provide(
          ConfigProvider.layer(ConfigProvider.fromUnknown({ CUSTOM_DOMAIN: "example.test" })),
        ),
      );

      assert.strictEqual(config.kind, "workers-dev");
    }),
  );

  it.effect("ignores STAGES_TEST_CUSTOM_DOMAIN's absence on a test stage", () =>
    Effect.gen(function* absent() {
      const config = yield* domainFor("test-i26").pipe(
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
      );

      assert.strictEqual(config.kind, "workers-dev");
    }),
  );
});

describe("wafRateLimitRule", () => {
  it("names the hostname in every rule expression", () => {
    const ruleset = wafRateLimitRule(
      "example.test",
      { mitigationSeconds: 10, periodSeconds: 10, requests: 50 },
      "app-prod-web-ratelimit",
    );

    assert.isTrue(
      ruleset.rules.every(
        (rule) => rule.expression?.includes('http.host eq "example.test"') === true,
      ),
    );
  });

  it("carries the expression, 50 per 10 s, block and a 10 s timeout", () => {
    const ruleset = wafRateLimitRule(
      "example.test",
      {
        mitigationSeconds: WAF_RATE_LIMIT_MITIGATION_SECONDS.default,
        periodSeconds: WAF_RATE_LIMIT_PERIOD_SECONDS.default,
        requests: WAF_RATE_LIMIT_REQUESTS.default,
      },
      "app-prod-web-ratelimit",
    );

    const [rule] = ruleset.rules;

    assert.strictEqual(ruleset.phase, "http_ratelimit");
    assert.strictEqual(ruleset.rules.length, 1);
    assert.strictEqual(
      rule.expression,
      'http.host eq "example.test" and not starts_with(http.request.uri.path, "/assets/")',
    );
    assert.strictEqual(rule.action, "block");
    assert.strictEqual(rule.ref, "app-prod-web-ratelimit");
    assert.deepStrictEqual(rule.ratelimit, {
      characteristics: ["ip.src"],
      mitigationTimeout: 10,
      period: 10,
      requestsPerPeriod: 50,
    });
  });
});
