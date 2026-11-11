import type {
  EnvironmentProps,
  LabelProps,
  RepositoryProps,
  RulesetProps,
  VariableProps,
} from "@alchemy.run/github";
import { Config, Option } from "effect";
import type { GuardedRepository } from "./repository.ts";
import type { Tier } from "./tier.ts";

/**
 * The GitHub Actions app id that stamps the required status checks.
 */
export const ACTIONS_INTEGRATION_ID = 15_368;

/**
 * The required status check contexts of the `main` ruleset, in declaration order.
 */
export const REQUIRED_CHECKS = [
  "checks",
  "pr-title",
  "pr-body",
  "reviewer-agent",
  "convention-guard",
  "merge-gate",
] as const;

/**
 * The labels the declaration names; every other label is a deletion candidate for part 3.
 */
export const LABELS = [
  "convention",
  "dependencies",
  "bug",
  "enhancement",
  "documentation",
  "merge-ready",
] as const;

/**
 * The props of every `@alchemy.run/github` resource the tier allows. Each prop object is exactly
 * what the provider resource takes; the stack names each resource after its `name`.
 */
export interface DeclarationPlan {
  readonly repository: RepositoryProps;
  readonly ruleset: ReadonlyArray<RulesetProps>;
  readonly environments: ReadonlyArray<EnvironmentProps>;
  readonly labels: ReadonlyArray<LabelProps>;
  readonly variables: ReadonlyArray<VariableProps>;
}

/**
 * One required status check: the context and the app that must stamp it.
 */
interface RequiredCheck {
  readonly context: string;
  readonly integrationId: number;
}

/**
 * Read the optional `GITHUB_REVIEWER_APP_ID`: the app id that stamps the `reviewer-agent` check.
 *
 * @returns The id when set, else none; a non-integer value fails through the error channel.
 */
export const reviewerAppId = Config.Int("GITHUB_REVIEWER_APP_ID").pipe(Config.option);

/**
 * Build the `main` ruleset props.
 *
 * @param repository - The guarded repository.
 * @param reviewer - The `reviewer-agent` app id, when set.
 * @returns The ruleset: PR required, strict checks, squash only, linear history, no bypass.
 */
const mainRuleset = (
  repository: GuardedRepository,
  reviewer: Option.Option<number>,
): RulesetProps => ({
  conditions: { include: ["~DEFAULT_BRANCH"] },
  deletion: true,
  name: "main",
  nonFastForward: true,
  owner: repository.owner,
  pullRequest: {
    allowedMergeMethods: ["squash"],
    requiredApprovingReviewCount: 0,
    requiredReviewThreadResolution: true,
  },
  repository: repository.name,
  requiredLinearHistory: true,
  requiredStatusChecks: {
    checks: REQUIRED_CHECKS.flatMap((context): ReadonlyArray<RequiredCheck> => {
      if (context !== "reviewer-agent") {
        return [{ context, integrationId: ACTIONS_INTEGRATION_ID }];
      }

      return Option.isSome(reviewer) ? [{ context, integrationId: reviewer.value }] : [];
    }),
    strictRequiredStatusChecksPolicy: true,
  },
});

/**
 * Whether `prod-destructive` gets the owner as its required reviewer: public repositories only,
 * and only a `User` owner, whose login is a valid reviewer. An organization login never is.
 *
 * @param repository - The guarded repository.
 * @returns True when the owner login is declared as the reviewer.
 */
const ownerReviews = (repository: GuardedRepository): boolean =>
  repository.visibility === "public" && repository.ownerType === "User";

/**
 * Build the environment props.
 *
 * @param repository - The guarded repository.
 * @returns `prod` and `prod-destructive`, both limited to `main`, the latter with a reviewer only
 *   under {@link ownerReviews}.
 */
const environments = (repository: GuardedRepository): ReadonlyArray<EnvironmentProps> => {
  const scope = {
    deploymentBranchPolicy: { customBranchPolicies: ["main"] },
    owner: repository.owner,
    repository: repository.name,
  };

  const destructive = { ...scope, name: "prod-destructive" };

  return [
    { ...scope, name: "prod" },
    ownerReviews(repository)
      ? { ...destructive, reviewers: { users: [repository.owner] } }
      : destructive,
  ];
};

/**
 * Build the repository props: the governed fields the tier allows, nothing else.
 *
 * @param repository - The guarded repository.
 * @param tier - The detected tier.
 * @returns Merge methods and delete-on-merge under `mergeSettings`, auto-merge under `autoMerge`.
 */
const repositoryProps = (repository: GuardedRepository, tier: Tier): RepositoryProps => {
  const base = { name: repository.name, owner: repository.owner };

  const merge = tier.capabilities.has("mergeSettings")
    ? {
        ...base,
        allowMergeCommit: false,
        allowRebaseMerge: false,
        allowSquashMerge: true,
        deleteBranchOnMerge: true,
      }
    : base;

  return tier.capabilities.has("autoMerge") ? { ...merge, allowAutoMerge: true } : merge;
};

/**
 * The `UNAVAILABLE` lines for declarations the plan leaves out for lack of an input.
 *
 * - `reviewer-agent` is not a required check without `GITHUB_REVIEWER_APP_ID`: with no integration id
 *   any app could stamp it.
 * - An organization owner on a public repository gets no `prod-destructive` reviewer: an organization
 *   login is not a reviewer, and a team or user must be configured.
 *
 * @param repository - The guarded repository.
 * @param tier - The detected tier.
 * @param reviewer - The optional `GITHUB_REVIEWER_APP_ID`.
 * @returns The warning lines, empty when nothing is left out.
 */
export const planWarnings = (
  repository: GuardedRepository,
  tier: Tier,
  reviewer: Option.Option<number>,
): ReadonlyArray<string> => [
  ...(tier.branchProtection === "ruleset" && Option.isNone(reviewer)
    ? ["UNAVAILABLE reviewer-agent check: GITHUB_REVIEWER_APP_ID not set"]
    : []),
  ...(tier.environments && repository.visibility === "public" && !ownerReviews(repository)
    ? ["UNAVAILABLE prod-destructive reviewer: organization owner needs a team or configured user"]
    : []),
];

/**
 * Map a tier to the provider declaration the stack applies.
 *
 * The repository declares governed fields only, never `isTemplate`, visibility or description.
 * Merge methods and delete-on-merge need the `mergeSettings` capability, auto-merge the `autoMerge`
 * one. The ruleset exists only when `BRANCH_PROTECTION` is `ruleset`, the environments only where
 * `ENVIRONMENTS` is true. The four tier variables and six labels always exist.
 *
 * @param repository - The guarded repository.
 * @param tier - The detected tier.
 * @param reviewer - The optional `GITHUB_REVIEWER_APP_ID`.
 * @returns The props of every resource, in dependency order.
 */
export const declarationPlan = (
  repository: GuardedRepository,
  tier: Tier,
  reviewer: Option.Option<number>,
): DeclarationPlan => {
  const scope = { owner: repository.owner, repository: repository.name };

  return {
    environments: tier.environments ? environments(repository) : [],
    labels: LABELS.map((name) => ({ ...scope, name })),
    repository: repositoryProps(repository, tier),
    ruleset: tier.branchProtection === "ruleset" ? [mainRuleset(repository, reviewer)] : [],
    variables: (
      [
        ["BRANCH_PROTECTION", tier.branchProtection],
        ["ENVIRONMENTS", String(tier.environments)],
        ["PREVIEW_ON", tier.previewOn],
        ["RELEASE_ON", String(tier.releaseOn)],
      ] as const
    ).map(([name, value]) => ({ ...scope, name, value })),
  };
};
