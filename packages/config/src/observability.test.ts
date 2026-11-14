import { assert, describe, it } from "@effect/vitest";
import { ConfigProvider, Effect, Exit } from "effect";
import { HeadSamplingRateKnob } from "./observability.ts";

const knobs = [{ default: "1", knob: HeadSamplingRateKnob }] as const;

describe.each(knobs)("$knob.key", ({ default: raw, knob }) => {
  it.effect("decodes its default from its string encoding", () =>
    Effect.gen(function* decodes() {
      assert.strictEqual(yield* knob.decode(raw), knob.default);
      assert.strictEqual(yield* knob.encode(knob.default), raw);
    }),
  );

  it.effect("reads its default when the key is absent", () =>
    Effect.gen(function* absent() {
      const read = yield* knob.config.pipe(
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
      );

      assert.strictEqual(read, knob.default);
    }),
  );

  it.effect.each(["1.5", "-0.1"])("rejects %s", (value) =>
    Effect.gen(function* rejects() {
      assert.isTrue(Exit.isFailure(yield* Effect.exit(knob.decode(value))));
    }),
  );
});
