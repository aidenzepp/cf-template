import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { PRO, PUBLIC, base, harness } from "./fake-github.ts";
import { RestSettingsError, applyRest } from "./rest.ts";

describe("applyRest", () => {
  it.effect("sends every call with its method, path and body on the public tier", () =>
    Effect.gen(function* publicTier() {
      const { lines, requests, run } = harness(applyRest, PUBLIC);
      const summary = yield* run;
      const body = (call: string) => requests.find((request) => request.call === call)?.body;

      assert.deepStrictEqual(summary, { applied: 10, failed: 0, unavailable: 0 });
      assert.deepStrictEqual(body(`PATCH ${base}`), {
        allow_update_branch: true,
        pull_request_creation_policy: "collaborators_only",
        squash_merge_commit_message: "PR_BODY",
        squash_merge_commit_title: "PR_TITLE",
      });
      assert.deepStrictEqual(
        requests.slice(1, 3).map((request) => request.body),
        [
          { security_and_analysis: { secret_scanning: { status: "enabled" } } },
          { security_and_analysis: { secret_scanning_push_protection: { status: "enabled" } } },
        ],
      );
      assert.deepStrictEqual(body(`PATCH ${base}/code-scanning/default-setup`), {
        query_suite: "default",
        state: "configured",
      });
      assert.deepStrictEqual(body(`PUT ${base}/actions/permissions`), {
        enabled: true,
        sha_pinning_required: true,
      });
      assert.deepStrictEqual(body(`PUT ${base}/actions/permissions/workflow`), {
        can_approve_pull_request_reviews: false,
        default_workflow_permissions: "read",
      });
      assert.deepStrictEqual(body(`PUT ${base}/actions/permissions/fork-pr-contributor-approval`), {
        approval_policy: "all_external_contributors",
      });

      for (const call of [
        `PUT ${base}/vulnerability-alerts`,
        `DELETE ${base}/automated-security-fixes`,
        `PUT ${base}/private-vulnerability-reporting`,
      ]) {
        assert.isTrue(requests.some((request) => request.call === call));
      }

      assert.include(lines, "applied sha-pinning-required 204");
    }),
  );

  it.effect("skips what a private Pro tier lacks and reports it unavailable", () =>
    Effect.gen(function* pro() {
      const { lines, requests, run } = harness(applyRest, PRO);
      const summary = yield* run;

      assert.deepStrictEqual(summary, { applied: 7, failed: 0, unavailable: 3 });
      assert.include(lines, "unavailable secret-scanning tier");
      assert.include(lines, "unavailable push-protection tier");
      assert.include(lines, "unavailable codeql-default-setup tier");
      assert.isFalse(requests.some((request) => request.call.includes("default-setup")));
    }),
  );

  it.effect("reports a plan-unavailable 403 or 422 on a tier-gated call as unavailable", () =>
    Effect.gen(function* gated() {
      const replies = new Map([
        [
          `PUT ${base}/actions/permissions`,
          {
            body: { message: "Secret scanning is not available for this repository." },
            status: 422,
          },
        ],
        [
          `PUT ${base}/vulnerability-alerts`,
          {
            body: { message: "Upgrade to GitHub Pro or make this repository public." },
            status: 403,
          },
        ],
      ]);

      const { lines, run } = harness(applyRest, PUBLIC, (call) => replies.get(call));
      const summary = yield* run;

      assert.strictEqual(summary.unavailable, 2);
      assert.include(lines, "unavailable dependabot-alerts 403");
      assert.include(lines, "unavailable sha-pinning-required 422");
    }),
  );

  it.effect(
    "reports a validation 422, or a 422 on an ungated call, as failed with its message",
    () =>
      Effect.gen(function* rejected() {
        const message = "Validation Failed: approval_policy is invalid.";
        const unavailable = "Private vulnerability reporting is not available for this repository.";

        const { lines, run } = harness(applyRest, PUBLIC, (call) => {
          if (call === `PUT ${base}/actions/permissions/fork-pr-contributor-approval`) {
            return { body: { message }, status: 422 };
          }

          return call === `PUT ${base}/private-vulnerability-reporting`
            ? { body: { message: unavailable }, status: 422 }
            : undefined;
        });

        const error = yield* Effect.flip(run);

        assert.instanceOf(error, RestSettingsError);
        assert.deepStrictEqual([error.applied, error.unavailable, error.failed], [8, 0, 2]);
        assert.include(lines, `failed fork-approval 422 ${message}`);
        assert.include(lines, `failed private-vulnerability-reporting 422 ${unavailable}`);
        assert.isFalse(lines.some((line) => line.includes("ghp_secret")));
      }),
  );

  it.effect("runs every remaining call after a 500 and fails at the end", () =>
    Effect.gen(function* failing() {
      const { lines, requests, run } = harness(applyRest, PUBLIC, (call) =>
        call === `PATCH ${base}` ? { status: 500 } : undefined,
      );

      const error = yield* Effect.flip(run);

      assert.instanceOf(error, RestSettingsError);
      assert.deepStrictEqual([error.applied, error.unavailable, error.failed], [7, 0, 3]);
      assert.include(lines, "failed merge-extras 500");
      assert.isTrue(
        requests.some((request) => request.call === `PUT ${base}/actions/permissions/workflow`),
      );
    }),
  );
});
