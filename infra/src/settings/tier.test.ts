import { assert, describe, it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import type { GuardedRepository } from "./repository.ts";
import { UNSUPPORTED_OWNER, detectPlan, detectTier, reportLine } from "./tier.ts";

/**
 * The owner and plan fields a fake route returns.
 */
interface PlanBody {
  readonly login?: string;
  readonly plan: { readonly name: string };
}

type Routes = Readonly<Record<string, PlanBody>>;

/**
 * A fake `HttpClient` that answers each path from `routes` and 404s every other path.
 *
 * @param routes - The JSON body per request path, all with status 200.
 * @returns The layer providing the client.
 */
const fakeGitHub = (routes: Routes) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url) => {
      const body = routes[url.pathname];

      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json(body ?? {}, { status: body === undefined ? 404 : 200 }),
        ),
      );
    }),
  );

const config = ConfigProvider.layer(ConfigProvider.fromUnknown({ GITHUB_TOKEN: "ghp_secret" }));

const user: GuardedRepository = {
  name: "widget",
  owner: "acme",
  ownerType: "User",
  visibility: "private",
};

/**
 * Detect the tier of `repository` against the fake routes.
 *
 * @param repository - The guarded repository.
 * @param routes - The fake GitHub responses.
 * @param secrets - The repository's secret names.
 * @returns The tier.
 */
const tierOf = (
  repository: GuardedRepository,
  routes: Routes,
  secrets: ReadonlyArray<string> = [],
) => detectTier(repository, secrets).pipe(Effect.provide([fakeGitHub(routes), config]));

const userPlan = (name: string) => ({ "/user": { login: "acme", plan: { name } } });

describe("detectTier", () => {
  it.effect("gives a public repository everything on any plan", () =>
    Effect.gen(function* publicTier() {
      const tier = yield* tierOf({ ...user, visibility: "public" }, userPlan("free"));

      assert.strictEqual(tier.branchProtection, "ruleset");
      assert.isTrue(tier.environments);
      assert.strictEqual(tier.previewOn, "every-push");
      assert.isTrue(tier.capabilities.has("codeql"));
      assert.isTrue(tier.capabilities.has("environmentReviewers"));
    }),
  );

  it.effect("gives a private Pro repository rulesets but not reviewers or scanning", () =>
    Effect.gen(function* pro() {
      const tier = yield* tierOf(user, userPlan("pro"));

      assert.strictEqual(tier.branchProtection, "ruleset");
      assert.isTrue(tier.environments);
      assert.strictEqual(tier.previewOn, "merge-ready");

      for (const capability of ["autoMerge", "environmentSecrets", "shaPin"] as const) {
        assert.isTrue(tier.capabilities.has(capability));
      }

      for (const capability of [
        "environmentReviewers",
        "secretScanning",
        "pushProtection",
        "codeql",
        "forkApproval",
        "privateVulnerabilityReporting",
      ] as const) {
        assert.isFalse(tier.capabilities.has(capability));
      }
    }),
  );

  it.effect("gives a private Free repository no branch protection", () =>
    Effect.gen(function* free() {
      const tier = yield* tierOf(user, userPlan("free"));

      assert.strictEqual(tier.branchProtection, "none");
      assert.isFalse(tier.environments);
      assert.sameMembers(
        [...tier.capabilities],
        ["actionsSettings", "dependabotAlerts", "mergeSettings"],
      );
    }),
  );

  it.effect("reads an organization plan from /orgs", () =>
    Effect.gen(function* organization() {
      const tier = yield* tierOf(
        { ...user, ownerType: "Organization" },
        { "/orgs/acme": { plan: { name: "team" } } },
      );

      assert.strictEqual(tier.plan, "team");
      assert.strictEqual(tier.branchProtection, "ruleset");
    }),
  );

  it.effect("sets RELEASE_ON only when both App secrets exist", () =>
    Effect.gen(function* release() {
      const both = yield* tierOf(user, userPlan("pro"), ["APP_ID", "APP_PRIVATE_KEY"]);
      const one = yield* tierOf(user, userPlan("pro"), ["APP_ID"]);

      assert.isTrue(both.releaseOn);
      assert.isFalse(one.releaseOn);
    }),
  );
});

describe("detectPlan", () => {
  it.effect("reports an unsupported owner type", () =>
    Effect.gen(function* unsupported() {
      const routes = fakeGitHub({ ...userPlan("pro") });

      const other = yield* detectPlan({ ...user, owner: "someone-else" }).pipe(
        Effect.provide([routes, config]),
      );

      const bot = yield* detectPlan({ ...user, ownerType: "Bot" }).pipe(
        Effect.provide([routes, config]),
      );

      assert.strictEqual(other, UNSUPPORTED_OWNER);
      assert.strictEqual(bot, UNSUPPORTED_OWNER);
    }),
  );
});

describe("reportLine", () => {
  it("formats the tier, applied and unavailable counts", () => {
    assert.strictEqual(
      reportLine({ plan: "pro", visibility: "private" }, 5, 4),
      "tier: private/pro; applied 5; unavailable 4",
    );
  });
});
