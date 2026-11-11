import { assert, describe, it } from "@effect/vitest";
import { ConfigProvider, Effect, Exit } from "effect";
import {
  WAF_RATE_LIMIT_MITIGATION_SECONDS,
  WAF_RATE_LIMIT_PERIOD_SECONDS,
  WAF_RATE_LIMIT_REQUESTS,
  wafKnobs,
} from "./waf.ts";

describe.each([
  { default: 50, knob: WAF_RATE_LIMIT_REQUESTS },
  { default: 10, knob: WAF_RATE_LIMIT_PERIOD_SECONDS },
  { default: 10, knob: WAF_RATE_LIMIT_MITIGATION_SECONDS },
])("$knob.key", ({ default: expected, knob }) => {
  it("defaults to the approved value", () => {
    assert.strictEqual(knob.default, expected);
  });

  it.effect("decodes its default", () =>
    Effect.gen(function* decodes() {
      assert.strictEqual(yield* knob.decode(String(expected)), expected);
    }),
  );

  it.effect("rejects 0", () =>
    Effect.gen(function* rejects() {
      assert.isTrue(Exit.isFailure(yield* Effect.exit(knob.decode("0"))));
    }),
  );
});

describe.each([WAF_RATE_LIMIT_PERIOD_SECONDS, WAF_RATE_LIMIT_MITIGATION_SECONDS])(
  "$key",
  (knob) => {
    it.effect("rejects a duration Cloudflare does not offer", () =>
      Effect.gen(function* rejects() {
        assert.isTrue(Exit.isFailure(yield* Effect.exit(knob.decode("7"))));
      }),
    );
  },
);

describe("wafKnobs", () => {
  it.effect("reads the defaults when nothing is supplied", () =>
    Effect.gen(function* reads() {
      const values = yield* wafKnobs.pipe(
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
      );

      assert.deepStrictEqual(values, { mitigationSeconds: 10, periodSeconds: 10, requests: 50 });
    }),
  );
});
