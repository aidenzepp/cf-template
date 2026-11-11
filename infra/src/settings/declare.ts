import { Config, Option, Schema } from "effect";
import type { GuardedRepository } from "./repository.ts";
import type { Tier } from "./tier.ts";

/**
 * The pinned Alchemy (`2.0.0-beta.85`) ships no GitHub provider. Every resource the declaration
 * needs is missing: there is no `GitHub.Repository`, `GitHub.Ruleset`, `GitHub.Environment`,
 * `GitHub.Label`, `GitHub.Variable` or `GitHub.fromToken`. Only `inMemoryState()` exists.
 */
export const MISSING_GITHUB_RESOURCES = [
  "GitHub.Repository",
  "GitHub.Ruleset",
  "GitHub.Environment",
  "GitHub.Label",
  "GitHub.Variable",
  "GitHub.fromToken",
] as const;

/**
 * The declaration cannot be applied: the pinned Alchemy has no GitHub provider.
 *
 * TODO: replace with the `GitHub.*` resource calls once a pinned Alchemy ships the provider. The
 * plan from {@link declarationPlan} is the input to that mapping.
 */
export class GitHubProviderMissing extends Schema.TaggedError<GitHubProviderMissing>()(
  "GitHubProviderMissing",
  { message: Schema.String },
) {}

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
 * A required status check; `integrationId` is the app that must stamp it, unset for any app.
 */
export interface StatusCheck {
  readonly context: string;
  readonly integrationId: number | undefined;
}

/**
 * One resource of the declaration: the Alchemy resource kind, its logical id and its props.
 */
export type Declaration =
  | {
      readonly kind: "Repository";
      readonly id: string;
      readonly props: {
        readonly owner: string;
        readonly name: string;
        readonly allowMergeCommit: boolean;
        readonly allowRebaseMerge: boolean;
        readonly allowSquashMerge: boolean;
        readonly deleteBranchOnMerge: boolean;
      };
    }
  | {
      readonly kind: "Ruleset";
      readonly id: string;
      readonly props: {
        readonly name: string;
        readonly adopt: boolean;
        readonly bypassActors: ReadonlyArray<string>;
        readonly checks: ReadonlyArray<StatusCheck>;
        readonly strictChecks: boolean;
        readonly mergeMethods: ReadonlyArray<string>;
        readonly requiredApprovals: number;
        readonly requireThreadResolution: boolean;
        readonly linearHistory: boolean;
        readonly blockDeletion: boolean;
        readonly blockForcePush: boolean;
      };
    }
  | {
      readonly kind: "Environment";
      readonly id: string;
      readonly props: {
        readonly name: string;
        readonly branches: ReadonlyArray<string>;
        readonly reviewers: ReadonlyArray<string>;
      };
    }
  | { readonly kind: "Label"; readonly id: string; readonly props: { readonly name: string } }
  | {
      readonly kind: "Variable";
      readonly id: string;
      readonly props: { readonly name: string; readonly value: string };
    };

/**
 * Read the optional `GITHUB_REVIEWER_APP_ID`: the app id that stamps the `reviewer-agent` check.
 *
 * @returns The id when set, else none; a non-integer value fails through the error channel.
 */
export const reviewerAppId = Config.Int("GITHUB_REVIEWER_APP_ID").pipe(Config.option);

/**
 * Build the `main` ruleset declaration.
 *
 * @param reviewer - The `reviewer-agent` app id, when set.
 * @returns The ruleset: PR required, strict checks, squash only, linear history, no bypass.
 */
const mainRuleset = (reviewer: Option.Option<number>): Declaration => ({
  id: "main",
  kind: "Ruleset",
  props: {
    adopt: true,
    blockDeletion: true,
    blockForcePush: true,
    bypassActors: [],
    checks: REQUIRED_CHECKS.map((context) => ({
      context,
      integrationId:
        context === "reviewer-agent" ? Option.getOrUndefined(reviewer) : ACTIONS_INTEGRATION_ID,
    })),
    linearHistory: true,
    mergeMethods: ["squash"],
    name: "main",
    requireThreadResolution: true,
    requiredApprovals: 0,
    strictChecks: true,
  },
});

/**
 * Build the environment declarations.
 *
 * @param repository - The guarded repository; the required reviewer is its owner.
 * @returns `prod`, limited to `main`, and `prod-destructive`, with a reviewer on public only.
 */
const environments = (repository: GuardedRepository): ReadonlyArray<Declaration> => [
  {
    id: "prod",
    kind: "Environment",
    props: { branches: ["main"], name: "prod", reviewers: [] },
  },
  {
    id: "prod-destructive",
    kind: "Environment",
    props: {
      branches: [],
      name: "prod-destructive",
      reviewers: repository.visibility === "public" ? [repository.owner] : [],
    },
  },
];

/**
 * Map a tier to the declaration the stack applies.
 *
 * The repository declares governed fields only, never `isTemplate`, visibility or description.
 * The ruleset exists only when `BRANCH_PROTECTION` is `ruleset`, the environments only where
 * `ENVIRONMENTS` is true. The four tier variables and six labels always exist.
 *
 * @param repository - The guarded repository.
 * @param tier - The detected tier.
 * @param reviewer - The optional `GITHUB_REVIEWER_APP_ID`.
 * @returns The declarations in dependency order.
 */
export const declarationPlan = (
  repository: GuardedRepository,
  tier: Tier,
  reviewer: Option.Option<number>,
): ReadonlyArray<Declaration> => [
  {
    id: "repository",
    kind: "Repository",
    props: {
      allowMergeCommit: false,
      allowRebaseMerge: false,
      allowSquashMerge: true,
      deleteBranchOnMerge: true,
      name: repository.name,
      owner: repository.owner,
    },
  },
  ...(tier.branchProtection === "ruleset" ? [mainRuleset(reviewer)] : []),
  ...(tier.environments ? environments(repository) : []),
  ...LABELS.map((name): Declaration => ({ id: name, kind: "Label", props: { name } })),
  ...(
    [
      ["BRANCH_PROTECTION", tier.branchProtection],
      ["ENVIRONMENTS", String(tier.environments)],
      ["PREVIEW_ON", tier.previewOn],
      ["RELEASE_ON", String(tier.releaseOn)],
    ] as const
  ).map(([name, value]): Declaration => ({ id: name, kind: "Variable", props: { name, value } })),
];
