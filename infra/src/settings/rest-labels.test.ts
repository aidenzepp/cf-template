import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { PRO, base, harness } from "./fake-github.ts";
import { DEFAULT_LABELS, applyRestLabels } from "./rest-labels.ts";
import { RestSettingsError } from "./rest.ts";

const analyses = `GET ${base}/code-scanning/analyses`;

/**
 * Answer the analyses read with one analysis and the rulesets read with one page of `pages` per
 * `page` number (empty past the last). Without `includes_parents=false`, `parent` is listed first.
 *
 * @param pages - The repository's own rulesets, one array per page.
 * @param parent - An organization ruleset that only an unfiltered listing shows.
 * @returns The `answer` function for `harness`.
 */
const withAnalysis =
  (pages: ReadonlyArray<ReadonlyArray<unknown>>, parent: ReadonlyArray<unknown> = []) =>
  (call: string, search: string) => {
    const params = new URLSearchParams(search);
    const own = pages[Number(params.get("page") ?? 1) - 1] ?? [];
    const listed = params.get("includes_parents") === "false" ? own : [...parent, ...own];

    if (call === analyses) {
      return { body: [{ id: 1 }], status: 200 };
    }

    return call === `GET ${base}/rulesets` ? { body: listed, status: 200 } : undefined;
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
  it.effect("deletes the seven default labels and treats a missing one as applied", () =>
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

      assert.deepStrictEqual(summary, { applied: 7, failed: 0, unavailable: 0 });
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
        withAnalysis([[{ id: 7, name: "code-scanning" }]]),
      );

      yield* updated.run;
      assert.isTrue(updated.requests.some((request) => request.call === `PUT ${base}/rulesets/7`));
      assert.isFalse(updated.requests.some((request) => request.call === `POST ${base}/rulesets`));
    }),
  );

  it.effect("finds the repository's own ruleset on the second page", () =>
    Effect.gen(function* paged() {
      const { requests, run } = harness(
        applyRestLabels,
        PRO,
        withAnalysis([[{ id: 3, name: "other" }], [{ id: 7, name: "code-scanning" }]]),
      );

      yield* run;

      const reads = requests.filter((request) => request.call === `GET ${base}/rulesets`);

      assert.strictEqual(reads.length, 3);
      assert.isTrue(requests.some((request) => request.call === `PUT ${base}/rulesets/7`));
      assert.isFalse(requests.some((request) => request.call === `POST ${base}/rulesets`));
    }),
  );

  it.effect("lists only the repository's own rulesets so an organization one is ignored", () =>
    Effect.gen(function* parentRuleset() {
      const { requests, run } = harness(
        applyRestLabels,
        PRO,
        withAnalysis([[]], [{ id: 99, name: "code-scanning" }]),
      );

      yield* run;

      assert.isTrue(requests.some((request) => request.call === `POST ${base}/rulesets`));
      assert.isFalse(requests.some((request) => request.call === `PUT ${base}/rulesets/99`));
    }),
  );

  it.effect("skips the ruleset without the rulesets capability and fails on a 500", () =>
    Effect.gen(function* gated() {
      const skipped = harness(applyRestLabels, []);
      const summary = yield* skipped.run;

      assert.deepStrictEqual(summary, { applied: 7, failed: 0, unavailable: 1 });
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
