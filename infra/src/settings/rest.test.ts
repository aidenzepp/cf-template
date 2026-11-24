import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { PRO, PUBLIC, base, converged, harness } from "./fake-github.ts";
import type { Recorded, Reply } from "./fake-github.ts";
import { RestSettingsError, applyRest } from "./rest.ts";

/**
 * Answer the repository read as one where both features are off until each one's `PATCH` has been
 * sent, and read as `after` from then on. Every other call keeps the default.
 *
 * @param after - What the repository read says once the feature's `PATCH` is recorded.
 * @returns The `answer` function for `harness`.
 */
const afterWrite =
  (after: "enabled" | "disabled") =>
  (call: string, _search: string, recorded: ReadonlyArray<Recorded>) => {
    const status = (key: string) =>
      recorded.some(
        (request) =>
          request.call === `PATCH ${base}` && JSON.stringify(request.body).includes(`"${key}":`),
      )
        ? after
        : "disabled";

    return call === `GET ${base}`
      ? {
          body: {
            security_and_analysis: {
              secret_scanning: { status: status("secret_scanning") },
              secret_scanning_push_protection: {
                status: status("secret_scanning_push_protection"),
              },
            },
          },
          status: 200,
        }
      : undefined;
  };

/**
 * The repository read-back: secret scanning and push protection `enabled` once written.
 */
const readBack = afterWrite("enabled");

/**
 * A public-tier run whose read-back reports both features at one status once written.
 *
 * @param status - What the repository read-back says.
 * @returns The harness for {@link applyRest}.
 */
const reply = (status: "enabled" | "disabled") => harness(applyRest, PUBLIC, afterWrite(status));

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
        (call, search, recorded) => replies.get(call) ?? readBack(call, search, recorded),
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

      const { lines, run } = harness(applyRest, PUBLIC, (call, search, recorded) => {
        if (call === `PUT ${base}/actions/permissions/fork-pr-contributor-approval`) {
          return { body: { message }, status: 422 };
        }

        return call === `PUT ${base}/private-vulnerability-reporting`
          ? { body: { message: forbidden }, status: 403 }
          : readBack(call, search, recorded);
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
          harness(applyRest, PUBLIC, (call, search, recorded) =>
            call === path ? { body: { message }, status: 403 } : readBack(call, search, recorded),
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

const SETTINGS = [
  "merge-extras",
  "secret-scanning",
  "push-protection",
  "dependabot-alerts",
  "dependabot-security-updates-off",
  "codeql-default-setup",
  "private-vulnerability-reporting",
  "sha-pinning-required",
  "workflow-permissions",
  "fork-approval",
] as const;

/**
 * Answer the repository read as one that holds every declared value except the `stale` ones. A
 * stale `security_and_analysis` feature reads `disabled` until its `PATCH` is recorded.
 *
 * @param stale - The repository fields that differ: `allow_update_branch`, `secret_scanning` or
 *   `secret_scanning_push_protection`.
 * @returns The `answer` function for `harness`, which falls back to {@link converged}.
 */
const repositoryWith =
  (stale: ReadonlyArray<string>) =>
  (call: string, search: string, recorded: ReadonlyArray<Recorded>) => {
    if (call !== `GET ${base}`) {
      return converged(call, search);
    }

    const written = (key: string) =>
      recorded.some(
        (request) =>
          request.call === `PATCH ${base}` && JSON.stringify(request.body).includes(`"${key}":`),
      );

    const feature = (key: string) => ({
      status: stale.includes(key) && !written(key) ? "disabled" : "enabled",
    });

    return {
      body: {
        allow_update_branch: !stale.includes("allow_update_branch"),
        pull_request_creation_policy: "collaborators_only",
        security_and_analysis: {
          secret_scanning: feature("secret_scanning"),
          secret_scanning_push_protection: feature("secret_scanning_push_protection"),
        },
        squash_merge_commit_message: "PR_BODY",
        squash_merge_commit_title: "PR_TITLE",
      },
      status: 200,
    };
  };

/**
 * Answer as {@link converged} except for one read.
 *
 * @param read - The `GET path` that differs.
 * @param differing - Its reply.
 * @returns The `answer` function for `harness`.
 */
const differingAt =
  (read: string, differing: Reply) =>
  (call: string, search: string): Reply | undefined =>
    call === read ? differing : converged(call, search);

describe("applyRest on a repository that already holds the declared values", () => {
  for (const [name, tier, unavailable] of [
    ["public", PUBLIC, 0],
    ["private Pro", PRO, 5],
  ] as const) {
    it.effect(`reads each ${name} setting, writes none and counts none as applied`, () =>
      Effect.gen(function* unchanged() {
        const { lines, requests, run } = harness(applyRest, tier, converged);
        const summary = yield* run;

        assert.deepStrictEqual(summary, { applied: 0, failed: 0, unavailable });
        assert.isFalse(lines.some((line) => line.startsWith("applied ")));
        assert.strictEqual(
          lines.filter((line) => line.startsWith("unchanged ")).length,
          10 - unavailable,
        );
        assert.isTrue(requests.every((request) => request.call.startsWith("GET ")));
      }),
    );
  }

  it.effect("prints unchanged for each of the ten settings, in order", () =>
    Effect.gen(function* ordered() {
      const { lines, run } = harness(applyRest, PUBLIC, converged);

      yield* run;
      assert.deepStrictEqual(
        lines,
        SETTINGS.map((setting) => `unchanged ${setting}`),
      );
    }),
  );

  it.effect("writes again after a failed read, as it did before it read", () =>
    Effect.gen(function* unreadable() {
      const { lines, run } = harness(applyRest, PUBLIC, (call, search) =>
        call === `GET ${base}/actions/permissions` ? { status: 500 } : converged(call, search),
      );

      const summary = yield* run;

      assert.deepStrictEqual(summary, { applied: 1, failed: 0, unavailable: 0 });
      assert.include(lines, "applied sha-pinning-required 204");
    }),
  );
});

describe("applyRest when one setting differs", () => {
  const cases = [
    ["merge-extras", `PATCH ${base}`, repositoryWith(["allow_update_branch"])],
    ["secret-scanning", `PATCH ${base}`, repositoryWith(["secret_scanning"])],
    ["push-protection", `PATCH ${base}`, repositoryWith(["secret_scanning_push_protection"])],
    [
      "dependabot-alerts",
      `PUT ${base}/vulnerability-alerts`,
      differingAt(`GET ${base}/vulnerability-alerts`, { status: 404 }),
    ],
    [
      "dependabot-security-updates-off",
      `DELETE ${base}/automated-security-fixes`,
      differingAt(`GET ${base}/automated-security-fixes`, {
        body: { enabled: true, paused: false },
        status: 200,
      }),
    ],
    [
      "codeql-default-setup",
      `PATCH ${base}/code-scanning/default-setup`,
      differingAt(`GET ${base}/code-scanning/default-setup`, {
        body: { query_suite: "default", state: "not-configured" },
        status: 200,
      }),
    ],
    [
      "private-vulnerability-reporting",
      `PUT ${base}/private-vulnerability-reporting`,
      differingAt(`GET ${base}/private-vulnerability-reporting`, {
        body: { enabled: false },
        status: 200,
      }),
    ],
    [
      "sha-pinning-required",
      `PUT ${base}/actions/permissions`,
      differingAt(`GET ${base}/actions/permissions`, {
        body: { enabled: true, sha_pinning_required: false },
        status: 200,
      }),
    ],
    [
      "workflow-permissions",
      `PUT ${base}/actions/permissions/workflow`,
      differingAt(`GET ${base}/actions/permissions/workflow`, {
        body: { can_approve_pull_request_reviews: false, default_workflow_permissions: "write" },
        status: 200,
      }),
    ],
    [
      "fork-approval",
      `PUT ${base}/actions/permissions/fork-pr-contributor-approval`,
      differingAt(`GET ${base}/actions/permissions/fork-pr-contributor-approval`, {
        body: { approval_policy: "first_time_contributors" },
        status: 200,
      }),
    ],
  ] as const;

  for (const [setting, write, answer] of cases) {
    it.effect(`prints applied for ${setting} alone and unchanged for the other nine`, () =>
      Effect.gen(function* differs() {
        const { lines, requests, run } = harness(applyRest, PUBLIC, answer);
        const summary = yield* run;

        assert.deepStrictEqual(summary, { applied: 1, failed: 0, unavailable: 0 });
        assert.deepStrictEqual(
          lines,
          SETTINGS.map((name) => (name === setting ? `applied ${name} 204` : `unchanged ${name}`)),
        );
        assert.deepStrictEqual(
          requests
            .filter((request) => !request.call.startsWith("GET "))
            .map((request) => request.call),
          [write],
        );
      }),
    );
  }
});
