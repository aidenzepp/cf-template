import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { CloudflarePlanKnob } from "./plan.ts";
import { LogLevelKnob } from "./log-level.ts";

describe("knob string codec", () => {
  it.effect("round-trips the LogLevelKnob default", () =>
    Effect.gen(function* roundTrip() {
      const raw = yield* LogLevelKnob.encode(LogLevelKnob.default);

      assert.strictEqual(raw, "Info");
      assert.strictEqual(yield* LogLevelKnob.decode(raw), LogLevelKnob.default);
    }),
  );

  it.effect("round-trips the CloudflarePlanKnob default", () =>
    Effect.gen(function* roundTrip() {
      const raw = yield* CloudflarePlanKnob.encode(CloudflarePlanKnob.default);

      assert.strictEqual(raw, "paid");
      assert.strictEqual(yield* CloudflarePlanKnob.decode(raw), CloudflarePlanKnob.default);
    }),
  );
});
