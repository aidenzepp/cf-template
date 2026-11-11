import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { Stages, Workers } from "../stages.ts";
import { headSamplingRate, telemetryOptions } from "./telemetry.ts";
import { volumeAlertThreshold, volumeAlertWorkers } from "./alerts.ts";

describe("volumeAlertThreshold", () => {
  it("is 3472 at the default share and fraction", () => {
    assert.strictEqual(volumeAlertThreshold(0.5, 0.5), 3472);
  });

  it("is a positive integer for every share and fraction in (0, 1]", () => {
    const steps = [0.01, 0.1, 0.25, 0.5, 0.75, 1];

    for (const share of steps) {
      for (const fraction of steps) {
        const threshold = volumeAlertThreshold(share, fraction);

        assert.isTrue(Number.isInteger(threshold) && threshold > 0);
      }
    }
  });
});

describe("volumeAlertWorkers", () => {
  it.effect("lists each Worker in order, then the state store", () =>
    Effect.gen(function* lists() {
      const names = yield* volumeAlertWorkers("s", "test-abc");

      assert.deepStrictEqual(names, [
        "s-web-test-abc",
        "s-api-test-abc",
        "s-auth-test-abc",
        "s-state",
      ]);
      assert.strictEqual(names.length, Workers.length + 1);
    }),
  );
});

describe("volumeAlert flag", () => {
  it("is on for prod and test and off for staging and local", () => {
    assert.isTrue(Stages.prod.volumeAlert);
    assert.isTrue(Stages.test.volumeAlert);
    assert.isFalse(Stages.staging.volumeAlert);
    assert.isFalse(Stages.local.volumeAlert);
  });
});

describe("telemetry", () => {
  it("samples every request in every stage kind", () => {
    for (const stage of ["prod", "staging-1", "test-ci", "dev"] as const) {
      assert.strictEqual(headSamplingRate(stage), 1);
      assert.deepStrictEqual(telemetryOptions(stage), { headSamplingRate: 1 });
    }
  });
});
