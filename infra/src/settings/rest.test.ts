import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { PRO, PUBLIC, base, harness } from "./fake-github.ts";
import { RestSettingsError, applyRest } from "./rest.ts";

/**
 * The `security_and_analysis` object with both features at one status.
 *
 * @param status - `enabled` or `disabled`.
 * @returns The object GitHub returns for a repository.
 */
const pair = (status: "enabled" | "disabled") => ({
  security_and_analysis: {
    secret_scanning: { status },
    secret_scanning_push_protection: { status },
  },
});

/**
 * The repository read-back: secret scanning and push protection both `enabled`.
 */
const enabled = pair("enabled");

/**
 * Answer the read-back `GET` with {@link enabled}; every other call keeps the default.
 *
 * @param call - The `METHOD path` of the request.
 * @returns The canned read-back reply, or `undefined`.
 */
const readBack = (call: string) =>
  call === `GET ${base}` ? { body: enabled, status: 200 } : undefined;

/**
 * A public-tier run whose read-back reports both features at one status.
 *
 * @param status - What the repository read-back says.
 * @returns The harness for {@link applyRest}.
 */
const reply = (status: "enabled" | "disabled") =>
  harness(applyRest, PUBLIC, (call) =>
    call === `GET ${base}` ? { body: pair(status), status: 200 } : undefined,
  );

describe("applyRest", () => {
  it.effect("sends every call with its method, path and body on the public tier", () =>
    Effect.gen(function* publicTier() {
      const { lines, requests, run } = harness(applyRest, PUBLIC, readBack);
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
        requests
          .filter((request) => request.call === `PATCH ${base}`)
          .slice(1)
          .map((request) => request.body),
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

      assert.deepStrictEqual(summary, { applied: 5, failed: 0, unavailable: 5 });
      assert.include(lines, "unavailable secret-scanning tier");
      assert.include(lines, "unavailable push-protection tier");
      assert.include(lines, "unavailable codeql-default-setup tier");
      assert.include(lines, "unavailable private-vulnerability-reporting tier");
      assert.include(lines, "unavailable fork-approval tier");
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

      const { lines, run } = harness(
        applyRest,
        PUBLIC,
        (call) => replies.get(call) ?? readBack(call),
      );

      const summary = yield* run;

      assert.strictEqual(summary.unavailable, 2);
      assert.include(lines, "unavailable dependabot-alerts 403");
      assert.include(lines, "unavailable sha-pinning-required 422");
    }),
  );

  it.effect("reports a validation 422, or a 403 with an unrelated message, as failed", () =>
    Effect.gen(function* rejected() {
      const message = "Validation Failed: approval_policy is invalid.";
      const forbidden = "Resource not accessible by personal access token.";

      const { lines, run } = harness(applyRest, PUBLIC, (call) => {
        if (call === `PUT ${base}/actions/permissions/fork-pr-contributor-approval`) {
          return { body: { message }, status: 422 };
        }

        return call === `PUT ${base}/private-vulnerability-reporting`
          ? { body: { message: forbidden }, status: 403 }
          : readBack(call);
      });

      const error = yield* Effect.flip(run);

      assert.instanceOf(error, RestSettingsError);
      assert.deepStrictEqual([error.applied, error.unavailable, error.failed], [8, 0, 2]);
      assert.include(lines, `failed fork-approval 422 ${message}`);
      assert.include(lines, `failed private-vulnerability-reporting 403 ${forbidden}`);
      assert.isFalse(lines.some((line) => line.includes("ghp_secret")));
    }),
  );

  it.effect(
    "reports CodeQL's not-enabled 403 as unavailable and any other CodeQL 403 as failed",
    () =>
      Effect.gen(function* codeql() {
        const path = `PATCH ${base}/code-scanning/default-setup`;
        const wording = "Code scanning is not enabled for this repository. Please enable it.";

        const run403 = (message: string) =>
          harness(applyRest, PUBLIC, (call) =>
            call === path ? { body: { message }, status: 403 } : readBack(call),
          );

        const notEnabled = yield* run403(wording).run;
        const other = yield* Effect.flip(run403("Resource not accessible.").run);

        assert.deepStrictEqual([notEnabled.unavailable, notEnabled.failed], [1, 0]);
        assert.instanceOf(other, RestSettingsError);
        assert.deepStrictEqual([other.unavailable, other.failed], [0, 1]);
      }),
  );

  it.effect("counts push protection applied only when the read-back says enabled", () =>
    Effect.gen(function* readback() {
      const ignored = reply("disabled");
      const honored = reply("enabled");
      const summary = yield* ignored.run;

      yield* honored.run;
      assert.strictEqual(summary.unavailable, 2);
      assert.include(ignored.lines, "unavailable push-protection 204 silently ignored by GitHub");
      assert.include(honored.lines, "applied push-protection 204");
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
