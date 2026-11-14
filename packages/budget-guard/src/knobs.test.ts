import { assert, describe, it } from "@effect/vitest";
import { ConfigProvider, Effect, Exit, Option } from "effect";
import {
  BytesPerRequestKnob,
  CpuMsPerRequestKnob,
  GuardMultipleKnob,
  guardPerHour,
} from "./knobs.ts";

describe.each([CpuMsPerRequestKnob, BytesPerRequestKnob])("$key", (knob) => {
  it("has no default value", () => {
    assert.isTrue(Option.isNone(knob.default));
  });

  it.effect("reads none when the key is absent and some when it is set", () =>
    Effect.gen(function* reads() {
      const absent = yield* knob.config.pipe(
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
      );

      const set = yield* knob.config.pipe(
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ [knob.key]: "25" }))),
      );

      assert.isTrue(Option.isNone(absent));
      assert.deepStrictEqual(set, Option.some(25));
    }),
  );

  it.effect.each(["0", "-1", "abc"])("rejects %s", (value) =>
    Effect.gen(function* rejects() {
      assert.isTrue(Exit.isFailure(yield* Effect.exit(knob.decode(value))));
    }),
  );
});

describe("GUARD_MULTIPLE", () => {
  it("defaults to 10", () => {
    assert.strictEqual(GuardMultipleKnob.default, 10);
  });
});

describe("guardPerHour", () => {
  it("follows the tightest of the three allowances", () => {
    const base = { bytesPerRequest: 1, cpuMsPerRequest: 1, multiple: 10, share: 0.5 };

    // requests: 10_000_000 is tightest when both costs are tiny
    assert.closeTo(guardPerHour(base), 69_444.444, 0.001);
    // CPU: 30_000_000 / 100 = 300_000
    assert.closeTo(guardPerHour({ ...base, cpuMsPerRequest: 100 }), 2083.333, 0.001);
  });
});
