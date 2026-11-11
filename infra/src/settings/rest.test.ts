import { assert, describe, it } from "@effect/vitest";
import { ConfigProvider, Console, Effect, Layer } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import type { GuardedRepository } from "./repository.ts";
import { RestSettingsError, applyRest } from "./rest.ts";
import type { Capability } from "./tier.ts";

const repository: GuardedRepository = {
  name: "widget",
  owner: "acme",
  ownerType: "User",
  visibility: "private",
};

const PRO = [
  "mergeSettings",
  "dependabotAlerts",
  "actionsSettings",
  "rulesets",
  "classicProtection",
  "autoMerge",
  "environments",
  "environmentSecrets",
  "shaPin",
] as const;

const PUBLIC = [
  ...PRO,
  "environmentReviewers",
  "secretScanning",
  "pushProtection",
  "codeql",
] as const;

const config = ConfigProvider.layer(ConfigProvider.fromUnknown({ GITHUB_TOKEN: "ghp_secret" }));

const base = "/repos/acme/widget";

const analyses = `GET ${base}/code-scanning/analyses`;

interface Reply {
  readonly status: number;
  readonly body?: unknown;
}

/**
 * Run `applyRest` against a fake GitHub that records every request and printed line.
 *
 * @param capabilities - The tier's capabilities.
 * @param answer - The reply per `METHOD path`; the default is 204, and 404 for the analyses read.
 *   Return `undefined` for the default.
 * @returns The run, the recorded `METHOD path` list with bodies, and the printed lines.
 */
const harness = (
  capabilities: ReadonlyArray<Capability>,
  answer: (call: string) => Reply | undefined = () => {},
) => {
  const requests: Array<{ readonly call: string; readonly body: unknown }> = [];
  const lines: Array<string> = [];

  const client = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url) =>
      Effect.sync(() => {
        const call = `${request.method} ${url.pathname}`;

        const body: unknown =
          request.body._tag === "Uint8Array"
            ? JSON.parse(new TextDecoder().decode(request.body.body))
            : undefined;

        requests.push({ body, call });

        const reply = answer(call) ?? { status: call === analyses ? 404 : 204 };

        return HttpClientResponse.fromWeb(
          request,
          new Response(reply.status === 204 ? null : JSON.stringify(reply.body ?? {}), {
            status: reply.status,
          }),
        );
      }),
    ),
  );

  const run = applyRest(repository, { capabilities: new Set(capabilities) }).pipe(
    Effect.provide([client, config]),
    Effect.provideService(Console.Console, {
      ...globalThis.console,
      log: (...args: ReadonlyArray<unknown>) => {
        lines.push(args.join(" "));
      },
    }),
  );

  return { lines, requests, run };
};

/**
 * Answer the analyses read with one analysis and the rulesets read with `existing`.
 *
 * @param existing - The live rulesets.
 * @returns The `answer` function for {@link harness}.
 */
const withAnalysis = (existing: ReadonlyArray<unknown>) => (call: string) => {
  const bodies = new Map([
    [analyses, [{ id: 1 }]],
    [`GET ${base}/rulesets`, existing],
  ]);

  const body = bodies.get(call);

  return body === undefined ? undefined : { body, status: 200 };
};

describe("applyRest", () => {
  it.effect("sends every call with its method, path and body on the public tier", () =>
    Effect.gen(function* publicTier() {
      const { lines, requests, run } = harness(PUBLIC);
      const summary = yield* run;
      const body = (call: string) => requests.find((request) => request.call === call)?.body;

      assert.deepStrictEqual(summary, { applied: 17, failed: 0, unavailable: 0 });
      assert.deepStrictEqual(body(`PATCH ${base}`), {
        allow_merge_commit: false,
        allow_rebase_merge: false,
        allow_squash_merge: true,
        allow_update_branch: true,
        delete_branch_on_merge: true,
        pull_request_creation_policy: "collaborators_only",
        squash_merge_commit_message: "PR_BODY",
        squash_merge_commit_title: "PR_TITLE",
      });
      assert.deepStrictEqual(
        requests.slice(1, 4).map((request) => request.body),
        [
          { allow_auto_merge: true },
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
      const { lines, requests, run } = harness(PRO);
      const summary = yield* run;

      assert.deepStrictEqual(summary, { applied: 14, failed: 0, unavailable: 3 });
      assert.include(lines, "unavailable secret-scanning tier");
      assert.include(lines, "unavailable push-protection tier");
      assert.include(lines, "unavailable codeql-default-setup tier");
      assert.isFalse(requests.some((request) => request.call.includes("default-setup")));
    }),
  );

  it.effect("reports a 403 or 422 as unavailable, not failed", () =>
    Effect.gen(function* gated() {
      const statuses = new Map([
        [`PUT ${base}/private-vulnerability-reporting`, 422],
        [`PUT ${base}/vulnerability-alerts`, 403],
      ]);

      const { lines, run } = harness(PUBLIC, (call) => {
        const status = statuses.get(call);

        return status === undefined ? undefined : { status };
      });

      const summary = yield* run;

      assert.strictEqual(summary.unavailable, 2);
      assert.include(lines, "unavailable dependabot-alerts 403");
      assert.include(lines, "unavailable private-vulnerability-reporting 422");
    }),
  );

  it.effect("deletes the six default labels and treats a missing one as applied", () =>
    Effect.gen(function* labels() {
      const { lines, requests, run } = harness(PRO, (call) =>
        call.endsWith("/wontfix") ? { status: 404 } : undefined,
      );

      yield* run;

      assert.deepStrictEqual(
        requests
          .filter((request) => request.call.includes("/labels/"))
          .map((request) => request.call),
        [
          "duplicate",
          "good%20first%20issue",
          "help%20wanted",
          "invalid",
          "question",
          "wontfix",
        ].map((label) => `DELETE ${base}/labels/${label}`),
      );
      assert.include(lines, "applied delete-label wontfix 404");
    }),
  );

  it.effect("runs every remaining call after a 500 and fails at the end", () =>
    Effect.gen(function* failing() {
      const { lines, requests, run } = harness(PUBLIC, (call) =>
        call === `PATCH ${base}` ? { status: 500 } : undefined,
      );

      const error = yield* Effect.flip(run);

      assert.instanceOf(error, RestSettingsError);
      assert.deepStrictEqual([error.applied, error.unavailable, error.failed], [13, 0, 4]);
      assert.include(lines, "failed merge-settings 500");
      assert.isTrue(requests.some((request) => request.call === `DELETE ${base}/labels/wontfix`));
    }),
  );

  it.effect("prints PENDING and writes no ruleset until an analysis exists", () =>
    Effect.gen(function* pending() {
      const { lines, requests, run } = harness(PRO);

      yield* run;

      assert.include(lines, "PENDING code-scanning ruleset: no analysis on main yet");
      assert.isFalse(requests.some((request) => request.call.endsWith("/rulesets")));
    }),
  );

  it.effect("creates the code-scanning ruleset once, then updates it by id", () =>
    Effect.gen(function* ruleset() {
      const created = harness(PRO, withAnalysis([]));
      yield* created.run;
      assert.isTrue(created.requests.some((request) => request.call === `POST ${base}/rulesets`));

      const updated = harness(PRO, withAnalysis([{ id: 7, name: "code-scanning" }]));
      yield* updated.run;
      assert.isTrue(updated.requests.some((request) => request.call === `PUT ${base}/rulesets/7`));
      assert.isFalse(updated.requests.some((request) => request.call === `POST ${base}/rulesets`));
    }),
  );
});
