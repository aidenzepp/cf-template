import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { PRO, base, harness } from "./fake-github.ts";
import { DEFAULT_LABELS, applyRestLabels } from "./rest-labels.ts";
import { RestSettingsError } from "./rest.ts";

const analyses = `GET ${base}/code-scanning/analyses`;

/**
 * Answer the analyses read with one analysis and the rulesets read with `existing`.
 *
 * @param existing - The live rulesets.
 * @returns The `answer` function for `harness`.
 */
const withAnalysis = (existing: ReadonlyArray<unknown>) => (call: string) => {
  const bodies = new Map([
    [analyses, [{ id: 1 }]],
    [`GET ${base}/rulesets`, existing],
  ]);

  const body = bodies.get(call);

  return body === undefined ? undefined : { body, status: 200 };
};

/**
 * Answer the analyses read with 404 (none yet) and each listed call with its status.
 *
 * @param statuses - The status per `METHOD path`.
 * @returns The `answer` function for `harness`.
 */
const noAnalysis =
  (statuses: ReadonlyMap<string, number> = new Map()) =>
  (call: string) => ({
    status: statuses.get(call) ?? (call === analyses ? 404 : 204),
  });

describe("applyRestLabels", () => {
  it.effect("deletes the six default labels and treats a missing one as applied", () =>
    Effect.gen(function* labels() {
      const { lines, requests, run } = harness(
        applyRestLabels,
        PRO,
        noAnalysis(new Map([[`DELETE ${base}/labels/wontfix`, 404]])),
      );

      yield* run;

      assert.deepStrictEqual(
        requests
          .filter((request) => request.call.includes("/labels/"))
          .map((request) => request.call),
        DEFAULT_LABELS.map((label) => `DELETE ${base}/labels/${encodeURIComponent(label)}`),
      );
      assert.include(lines, "applied delete-label wontfix 404");
    }),
  );

  it.effect("prints PENDING and writes no ruleset until an analysis exists", () =>
    Effect.gen(function* pending() {
      const { lines, requests, run } = harness(applyRestLabels, PRO, noAnalysis());
      const summary = yield* run;

      assert.deepStrictEqual(summary, { applied: 6, failed: 0, unavailable: 0 });
      assert.include(lines, "PENDING code-scanning ruleset: no analysis on main yet");
      assert.isFalse(requests.some((request) => request.call.endsWith("/rulesets")));
    }),
  );

  it.effect("creates the code-scanning ruleset once, then updates it by id", () =>
    Effect.gen(function* ruleset() {
      const created = harness(applyRestLabels, PRO, withAnalysis([]));
      yield* created.run;
      assert.isTrue(created.requests.some((request) => request.call === `POST ${base}/rulesets`));

      const updated = harness(
        applyRestLabels,
        PRO,
        withAnalysis([{ id: 7, name: "code-scanning" }]),
      );

      yield* updated.run;
      assert.isTrue(updated.requests.some((request) => request.call === `PUT ${base}/rulesets/7`));
      assert.isFalse(updated.requests.some((request) => request.call === `POST ${base}/rulesets`));
    }),
  );

  it.effect("skips the ruleset without the rulesets capability and fails on a 500", () =>
    Effect.gen(function* gated() {
      const skipped = harness(applyRestLabels, []);
      const summary = yield* skipped.run;

      assert.deepStrictEqual(summary, { applied: 6, failed: 0, unavailable: 1 });
      assert.include(skipped.lines, "unavailable code-scanning-ruleset tier");
      assert.isFalse(skipped.requests.some((request) => request.call === analyses));

      const failing = harness(
        applyRestLabels,
        PRO,
        noAnalysis(new Map([[`DELETE ${base}/labels/invalid`, 500]])),
      );

      const error = yield* Effect.flip(failing.run);

      assert.instanceOf(error, RestSettingsError);
      assert.strictEqual(error.failed, 1);
      assert.isTrue(failing.requests.some((request) => request.call === analyses));
    }),
  );
});
