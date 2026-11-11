import { Effect, Schema } from "effect";
import { getJson } from "./repository.ts";
import type { GuardedRepository } from "./repository.ts";

/**
 * The plan value reported for an owner whose plan cannot be read.
 */
export const UNSUPPORTED_OWNER = "unsupported owner type";

/**
 * A setting the program can apply on a tier.
 */
export type Capability =
  | "rulesets"
  | "classicProtection"
  | "autoMerge"
  | "environments"
  | "environmentSecrets"
  | "environmentReviewers"
  | "dependabotAlerts"
  | "shaPin"
  | "secretScanning"
  | "pushProtection"
  | "codeql"
  | "mergeSettings"
  | "actionsSettings"
  | "forkApproval"
  | "privateVulnerabilityReporting";

/**
 * The tier the repository sits on, with the variable values it implies.
 */
export interface Tier {
  readonly visibility: "public" | "private";
  readonly plan: string;
  readonly capabilities: ReadonlySet<Capability>;
  readonly branchProtection: "ruleset" | "classic" | "none";
  readonly environments: boolean;
  readonly previewOn: "merge-ready" | "every-push";
  readonly releaseOn: boolean;
}

/**
 * The tier detection failed to read a plan.
 */
export class TierError extends Schema.TaggedError<TierError>()("TierError", {
  cause: Schema.Defect(),
  message: Schema.String,
}) {}

/**
 * What a private repository on Free gets.
 */
const FREE_PRIVATE: ReadonlyArray<Capability> = [
  "mergeSettings",
  "dependabotAlerts",
  "actionsSettings",
];

/**
 * What a private repository on Pro or Team adds to the Free set.
 */
const PAID_PRIVATE: ReadonlyArray<Capability> = [
  ...FREE_PRIVATE,
  "rulesets",
  "classicProtection",
  "autoMerge",
  "environments",
  "environmentSecrets",
  "shaPin",
];

/**
 * Everything, for a public repository on any plan. Fork approval and private vulnerability
 * reporting are public-only: on a private repository GitHub answers the fork-approval call 422
 * "Fork PR approval is not allowed for private repositories." and the reporting call 404.
 */
const PUBLIC: ReadonlyArray<Capability> = [
  ...PAID_PRIVATE,
  "forkApproval",
  "privateVulnerabilityReporting",
  "environmentReviewers",
  "secretScanning",
  "pushProtection",
  "codeql",
];

/**
 * The plan of the authenticated user.
 */
const UserResponse = Schema.Struct({
  login: Schema.String,
  plan: Schema.optional(Schema.Struct({ name: Schema.String })),
});

/**
 * The plan of an organization, absent when the token cannot see it.
 */
const OrganizationResponse = Schema.Struct({
  plan: Schema.optional(Schema.Struct({ name: Schema.String })),
});

/**
 * Read the plan name of the repository's owner.
 *
 * A `User` owner is read from `GET /user` when it is the token's user. An `Organization` owner is
 * read from `GET /orgs/{owner}`. Any other owner, another user, or an organization response
 * without a plan is {@link UNSUPPORTED_OWNER}.
 *
 * @param repository - The guarded repository.
 * @returns The lower-case plan name or {@link UNSUPPORTED_OWNER}.
 */
export const detectPlan = Effect.fn("detectPlan")(
  function* detectPlan(repository: GuardedRepository) {
    let plan;

    if (repository.ownerType === "User") {
      const user = yield* getJson("/user", UserResponse);
      plan = user.login === repository.owner ? user.plan : undefined;
    } else if (repository.ownerType === "Organization") {
      ({ plan } = yield* getJson(`/orgs/${repository.owner}`, OrganizationResponse));
    }

    return plan === undefined ? UNSUPPORTED_OWNER : plan.name.toLowerCase();
  },
  Effect.mapError(
    (cause) => new TierError({ cause, message: `Cannot read the plan of the repository owner.` }),
  ),
);

/**
 * Pick the capability set for a visibility and plan.
 *
 * @param visibility - The repository visibility.
 * @param plan - The lower-case plan name.
 * @returns The capabilities the tier offers.
 */
const capabilitiesFor = (
  visibility: Tier["visibility"],
  plan: string,
): ReadonlyArray<Capability> => {
  if (visibility === "public") {
    return PUBLIC;
  }

  return ["pro", "team", "enterprise"].includes(plan) ? PAID_PRIVATE : FREE_PRIVATE;
};

/**
 * Pick the branch-protection mode the capabilities allow.
 *
 * @param capabilities - The tier's capabilities.
 * @returns `ruleset` first, then `classic`, else `none`.
 */
const protectionFor = (capabilities: ReadonlySet<Capability>): Tier["branchProtection"] => {
  if (capabilities.has("rulesets")) {
    return "ruleset";
  }

  return capabilities.has("classicProtection") ? "classic" : "none";
};

/**
 * Detect the tier of a guarded repository.
 *
 * Public gets everything. Private on `pro`, `team` or `enterprise` gets rulesets, classic
 * protection, auto-merge, environments and environment secrets, Dependabot alerts and the SHA-pin
 * setting. Any other private plan, including an unreadable one, is Free: merge settings,
 * Dependabot alerts and Actions settings, with `BRANCH_PROTECTION=none`.
 *
 * @param repository - The guarded repository.
 * @param secrets - The names of the repository's secrets; `RELEASE_ON` needs `APP_ID` and
 *   `APP_PRIVATE_KEY`.
 * @returns The tier with its capability set and variable values.
 */
export const detectTier = Effect.fn("detectTier")(function* detectTier(
  repository: GuardedRepository,
  secrets: ReadonlyArray<string>,
) {
  const plan = yield* detectPlan(repository);
  const capabilities = new Set(capabilitiesFor(repository.visibility, plan));

  return {
    branchProtection: protectionFor(capabilities),
    capabilities,
    environments: capabilities.has("environments"),
    plan,
    previewOn: repository.visibility === "public" ? "every-push" : "merge-ready",
    releaseOn: secrets.includes("APP_ID") && secrets.includes("APP_PRIVATE_KEY"),
    visibility: repository.visibility,
  } satisfies Tier;
});

/**
 * Format the one report line the program prints.
 *
 * @param tier - The detected tier.
 * @param applied - The count of settings applied.
 * @param unavailable - The count of settings the tier does not offer.
 * @returns `tier: <visibility>/<plan>; applied N; unavailable M`.
 */
export const reportLine = (
  tier: Pick<Tier, "visibility" | "plan">,
  applied: number,
  unavailable: number,
): string =>
  `tier: ${tier.visibility}/${tier.plan}; applied ${applied}; unavailable ${unavailable}`;
