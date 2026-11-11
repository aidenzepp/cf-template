import { assert, describe, it } from "@effect/vitest";
import { ConfigProvider, Effect, Option } from "effect";
import {
  ACTIONS_INTEGRATION_ID,
  LABELS,
  REQUIRED_CHECKS,
  declarationPlan,
  planWarnings,
  reviewerAppId,
} from "./declare.ts";
import { PRO, PUBLIC } from "./fake-github.ts";
import type { GuardedRepository } from "./repository.ts";
import type { Tier } from "./tier.ts";

const repository: GuardedRepository = {
  name: "widget",
  owner: "acme",
  ownerType: "User",
  visibility: "private",
};

const publicTier: Tier = {
  branchProtection: "ruleset",
  capabilities: new Set(PUBLIC),
  environments: true,
  plan: "free",
  previewOn: "every-push",
  releaseOn: false,
  visibility: "public",
};

const proTier: Tier = {
  ...publicTier,
  capabilities: new Set(PRO),
  plan: "pro",
  previewOn: "merge-ready",
  visibility: "private",
};

const freeTier: Tier = {
  ...proTier,
  branchProtection: "none",
  capabilities: new Set(["mergeSettings", "dependabotAlerts", "actionsSettings"]),
  environments: false,
  plan: "free",
};

const planFor = (visibility: GuardedRepository["visibility"], tier: Tier) =>
  declarationPlan({ ...repository, visibility }, tier, Option.none());

describe("declarationPlan", () => {
  it("declares everything on a public repository, with a reviewer on prod-destructive", () => {
    const plan = planFor("public", publicTier);

    assert.deepStrictEqual(
      plan.ruleset.map((entry) => entry.name),
      ["main"],
    );

    assert.deepStrictEqual(
      plan.environments.map((entry) => entry.name),
      ["prod", "prod-destructive"],
    );

    const [prod, destructive] = plan.environments;
    assert.deepStrictEqual(prod?.deploymentBranchPolicy, { customBranchPolicies: ["main"] });
    assert.isUndefined(prod?.reviewers);
    assert.deepStrictEqual(destructive?.deploymentBranchPolicy, { customBranchPolicies: ["main"] });
    assert.deepStrictEqual(destructive?.reviewers, { users: ["acme"] });
  });

  it("declares no reviewer for an organization owner and warns", () => {
    const organization: GuardedRepository = {
      ...repository,
      ownerType: "Organization",
      visibility: "public",
    };

    const [, destructive] = declarationPlan(
      organization,
      publicTier,
      Option.some(4242),
    ).environments;

    assert.deepStrictEqual(destructive?.deploymentBranchPolicy, { customBranchPolicies: ["main"] });
    assert.isUndefined(destructive?.reviewers);

    assert.deepStrictEqual(planWarnings(organization, publicTier, Option.some(4242)), [
      "UNAVAILABLE prod-destructive reviewer: organization owner needs a team or configured user",
    ]);
  });

  it("declares the ruleset and environments on private Pro, without a reviewer", () => {
    const plan = planFor("private", proTier);

    assert.strictEqual(plan.ruleset.length, 1);
    assert.strictEqual(plan.environments.length, 2);
    assert.isUndefined(plan.environments[1]?.reviewers);
    assert.deepStrictEqual(planWarnings(repository, proTier, Option.some(4242)), []);
  });

  it("declares neither ruleset nor environments on private Free", () => {
    const plan = planFor("private", freeTier);

    assert.deepStrictEqual(plan.ruleset, []);
    assert.deepStrictEqual(plan.environments, []);
    assert.deepStrictEqual(plan.repository.name, "widget");
  });

  it("always declares the six labels and the four tier variables", () => {
    const plan = planFor("private", freeTier);

    assert.deepStrictEqual(
      plan.labels.map((entry) => entry.name),
      [...LABELS],
    );

    assert.deepStrictEqual(
      Object.fromEntries(plan.variables.map((entry) => [entry.name, entry.value])),
      {
        BRANCH_PROTECTION: "none",
        ENVIRONMENTS: "false",
        PREVIEW_ON: "merge-ready",
        RELEASE_ON: "false",
      },
    );
  });

  it("targets the repository on every resource", () => {
    const plan = planFor("private", proTier);

    for (const entry of [
      ...plan.ruleset,
      ...plan.environments,
      ...plan.labels,
      ...plan.variables,
    ]) {
      assert.deepStrictEqual([entry.owner, entry.repository], ["acme", "widget"]);
    }
  });

  it("leaves visibility, description and isTemplate undeclared", () => {
    assert.sameMembers(Object.keys(planFor("private", proTier).repository), [
      "allowAutoMerge",
      "allowMergeCommit",
      "allowRebaseMerge",
      "allowSquashMerge",
      "deleteBranchOnMerge",
      "name",
      "owner",
    ]);
  });

  it("declares auto-merge only where the tier has it", () => {
    const free = planFor("private", freeTier).repository;

    assert.isUndefined(free.allowAutoMerge);
    assert.isTrue(free.allowSquashMerge);
    assert.isTrue(planFor("private", proTier).repository.allowAutoMerge);
  });

  it("squashes only, deletes the head branch and leaves other repository fields to the tier", () => {
    const { repository: declared } = planFor("private", proTier);

    assert.deepStrictEqual(
      [
        declared.allowSquashMerge,
        declared.allowMergeCommit,
        declared.allowRebaseMerge,
        declared.deleteBranchOnMerge,
      ],
      [true, false, false, true],
    );
  });

  it("stamps the Actions app on every check but reviewer-agent, which takes the optional id", () => {
    const plan = declarationPlan(repository, proTier, Option.some(4242));
    const [ruleset] = plan.ruleset;
    const checks = ruleset?.requiredStatusChecks?.checks ?? [];

    assert.deepStrictEqual(
      checks.map((entry) => entry.context),
      [...REQUIRED_CHECKS],
    );

    for (const entry of checks) {
      assert.strictEqual(
        entry.integrationId,
        entry.context === "reviewer-agent" ? 4242 : ACTIONS_INTEGRATION_ID,
      );
    }
  });

  it("declares the main ruleset: pull request, strict checks, squash only, linear, no bypass", () => {
    const [ruleset] = planFor("private", proTier).ruleset;

    assert.strictEqual(ruleset?.name, "main");
    assert.deepStrictEqual(ruleset?.conditions, { include: ["~DEFAULT_BRANCH"] });
    assert.isTrue(ruleset?.requiredStatusChecks?.strictRequiredStatusChecksPolicy);
    assert.isTrue(ruleset?.requiredLinearHistory);
    assert.isTrue(ruleset?.deletion);
    assert.isTrue(ruleset?.nonFastForward);
    assert.isUndefined(ruleset?.bypassActors);

    assert.deepStrictEqual(ruleset?.pullRequest, {
      allowedMergeMethods: ["squash"],
      requiredApprovingReviewCount: 0,
      requiredReviewThreadResolution: true,
    });
  });

  it("omits the reviewer-agent check and warns when GITHUB_REVIEWER_APP_ID is unset", () => {
    const [ruleset] = planFor("private", proTier).ruleset;

    assert.deepStrictEqual(
      ruleset?.requiredStatusChecks?.checks.map((entry) => entry.context),
      REQUIRED_CHECKS.filter((context) => context !== "reviewer-agent"),
    );

    assert.deepStrictEqual(planWarnings(repository, proTier, Option.none()), [
      "UNAVAILABLE reviewer-agent check: GITHUB_REVIEWER_APP_ID not set",
    ]);
  });
});

describe("reviewerAppId", () => {
  it.effect("is none when unset and the integer when set", () =>
    Effect.gen(function* reviewerConfig() {
      const unset = yield* reviewerAppId.pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({})),
      );

      const set = yield* reviewerAppId.pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({ GITHUB_REVIEWER_APP_ID: "4242" }),
        ),
      );

      assert.isTrue(Option.isNone(unset));
      assert.deepStrictEqual(set, Option.some(4242));
    }),
  );
});
