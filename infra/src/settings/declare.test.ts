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
import type { Declaration } from "./declare.ts";
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
  capabilities: new Set(),
  environments: true,
  plan: "free",
  previewOn: "every-push",
  releaseOn: false,
  visibility: "public",
};

const proTier: Tier = {
  ...publicTier,
  plan: "pro",
  previewOn: "merge-ready",
  visibility: "private",
};

const freeTier: Tier = {
  ...proTier,
  branchProtection: "none",
  environments: false,
  plan: "free",
};

/**
 * The declarations of one resource kind, narrowed to that kind.
 *
 * @param plan - The declarations.
 * @param kind - The resource kind.
 * @returns The matching declarations in order.
 */
const ofKind = <K extends Declaration["kind"]>(plan: ReadonlyArray<Declaration>, kind: K) =>
  plan.filter((entry): entry is Extract<Declaration, { readonly kind: K }> => entry.kind === kind);

/**
 * The ids of one resource kind in a plan.
 *
 * @param plan - The declarations.
 * @param kind - The resource kind.
 * @returns The ids in declaration order.
 */
const idsOf = (plan: ReadonlyArray<Declaration>, kind: Declaration["kind"]) =>
  Array.from(ofKind(plan, kind), (entry) => entry.id);

const planFor = (visibility: GuardedRepository["visibility"], tier: Tier) =>
  declarationPlan({ ...repository, visibility }, tier, Option.none());

describe("declarationPlan", () => {
  it("declares everything on a public repository, with a reviewer on prod-destructive", () => {
    const plan = planFor("public", publicTier);

    assert.deepStrictEqual(idsOf(plan, "Ruleset"), ["main"]);
    assert.deepStrictEqual(idsOf(plan, "Environment"), ["prod", "prod-destructive"]);

    const [prod, destructive] = ofKind(plan, "Environment");
    assert.deepStrictEqual(prod?.props.branches, ["main"]);
    assert.deepStrictEqual(destructive?.props.branches, ["main"]);
    assert.deepStrictEqual(destructive?.props.reviewers, ["acme"]);
  });

  it("declares no reviewer for an organization owner and warns", () => {
    const organization: GuardedRepository = {
      ...repository,
      ownerType: "Organization",
      visibility: "public",
    };

    const plan = declarationPlan(organization, publicTier, Option.some(4242));
    const [, destructive] = ofKind(plan, "Environment");

    assert.deepStrictEqual(destructive?.props.branches, ["main"]);
    assert.deepStrictEqual(destructive?.props.reviewers, []);

    assert.deepStrictEqual(planWarnings(organization, publicTier, Option.some(4242)), [
      "UNAVAILABLE prod-destructive reviewer: organization owner needs a team or configured user",
    ]);
  });

  it("declares the ruleset and environments on private Pro, without a reviewer", () => {
    const plan = planFor("private", proTier);

    assert.deepStrictEqual(idsOf(plan, "Ruleset"), ["main"]);
    assert.deepStrictEqual(idsOf(plan, "Environment"), ["prod", "prod-destructive"]);

    const [, destructive] = ofKind(plan, "Environment");
    assert.deepStrictEqual(destructive?.props.branches, ["main"]);
    assert.deepStrictEqual(destructive?.props.reviewers, []);

    assert.deepStrictEqual(planWarnings(repository, proTier, Option.some(4242)), []);
  });

  it("declares neither ruleset nor environments on private Free", () => {
    const plan = planFor("private", freeTier);

    assert.deepStrictEqual(idsOf(plan, "Ruleset"), []);
    assert.deepStrictEqual(idsOf(plan, "Environment"), []);
    assert.deepStrictEqual(idsOf(plan, "Repository"), ["repository"]);
  });

  it("always declares the six labels and the four tier variables", () => {
    const plan = planFor("private", freeTier);

    assert.deepStrictEqual(idsOf(plan, "Label"), [...LABELS]);

    assert.deepStrictEqual(idsOf(plan, "Variable"), [
      "BRANCH_PROTECTION",
      "ENVIRONMENTS",
      "PREVIEW_ON",
      "RELEASE_ON",
    ]);

    const values = Object.fromEntries(
      ofKind(plan, "Variable").map((entry) => [entry.id, entry.props.value]),
    );

    assert.deepStrictEqual(values, {
      BRANCH_PROTECTION: "none",
      ENVIRONMENTS: "false",
      PREVIEW_ON: "merge-ready",
      RELEASE_ON: "false",
    });
  });

  it("leaves visibility, description and isTemplate undeclared", () => {
    const [repo] = ofKind(planFor("private", proTier), "Repository");

    assert.sameMembers(Object.keys(repo?.props ?? {}), [
      "allowMergeCommit",
      "allowRebaseMerge",
      "allowSquashMerge",
      "deleteBranchOnMerge",
      "name",
      "owner",
    ]);
  });

  it("stamps the Actions app on every check but reviewer-agent, which takes the optional id", () => {
    const plan = declarationPlan(repository, proTier, Option.some(4242));
    const [ruleset] = ofKind(plan, "Ruleset");

    assert.deepStrictEqual(
      ruleset?.props.checks.map((entry) => entry.context),
      [...REQUIRED_CHECKS],
    );

    for (const entry of ruleset?.props.checks ?? []) {
      assert.strictEqual(
        entry.integrationId,
        entry.context === "reviewer-agent" ? 4242 : ACTIONS_INTEGRATION_ID,
      );
    }

    assert.isTrue(ruleset?.props.adopt);
    assert.deepStrictEqual(ruleset?.props.bypassActors, []);
    assert.deepStrictEqual(ruleset?.props.mergeMethods, ["squash"]);
  });

  it("omits the reviewer-agent check and warns when GITHUB_REVIEWER_APP_ID is unset", () => {
    const [ruleset] = ofKind(planFor("private", proTier), "Ruleset");

    assert.deepStrictEqual(
      ruleset?.props.checks.map((entry) => entry.context),
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
