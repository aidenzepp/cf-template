import { assert, describe, it } from "@effect/vitest";
import type { StageName } from "../stages.ts";
import {
  headSamplingRate,
  issuesObservability,
  recordsDiagnostics,
  telemetryOptions,
  webObservability,
} from "./telemetry.ts";

/**
 * The stages that keep traces and Workers Issues: `prod`, a `staging` stage and the local stage.
 */
const recorded = ["prod", "staging-1", "dev"] as const satisfies ReadonlyArray<StageName>;

/**
 * The `test` kind stages, which drop traces and Workers Issues.
 */
const lean = ["test-ci", "test-abc"] as const satisfies ReadonlyArray<StageName>;

describe("telemetry", () => {
  it("samples every request in every stage kind", () => {
    for (const stage of [...recorded, ...lean]) {
      assert.strictEqual(headSamplingRate(stage), 1);
      assert.strictEqual(telemetryOptions(stage).headSamplingRate, 1);
    }
  });

  it("keeps the default logs on every Worker of every stage", () => {
    for (const stage of [...recorded, ...lean]) {
      for (const observability of [webObservability(stage), issuesObservability(stage)]) {
        assert.isTrue(observability.enabled);
        assert.deepStrictEqual(observability.logs, { enabled: true, invocationLogs: true });
      }
    }
  });

  it("turns traces and Issues on for all three Workers outside the test kind", () => {
    for (const stage of recorded) {
      assert.isTrue(recordsDiagnostics(stage));
      assert.deepStrictEqual(webObservability(stage).traces, {
        enabled: true,
        headSamplingRate: 1,
      });
      assert.deepStrictEqual(telemetryOptions(stage), { enabled: true, headSamplingRate: 1 });

      for (const observability of [webObservability(stage), issuesObservability(stage)]) {
        assert.isTrue(observability.issues.enabled);
      }
    }
  });

  it("turns traces and Issues off for all three Workers on the test kind", () => {
    for (const stage of lean) {
      assert.isFalse(recordsDiagnostics(stage));
      assert.isFalse(webObservability(stage).traces.enabled);
      assert.deepStrictEqual(telemetryOptions(stage), { enabled: false, headSamplingRate: 1 });

      for (const observability of [webObservability(stage), issuesObservability(stage)]) {
        assert.isFalse(observability.issues.enabled);
      }
    }
  });
});
