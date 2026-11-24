/**
 * The GitHub Actions app id that stamps the required status checks.
 */
export const ACTIONS_INTEGRATION_ID = 15_368;

/**
 * The required status check contexts of the `main` ruleset, in declaration order.
 *
 * Each Actions context names a job a workflow under `.github/workflows` runs today, so no pull
 * request waits on a check nothing reports; `required-checks.test.ts` enforces it. A context joins
 * in the pull request that adds its job: `merge-gate` with the merge-gate job, and `pr-title`,
 * `pr-body` and `convention-guard` with the pull-request workflows of #43. `reviewer-agent` is
 * stamped by an app, not a workflow, and is declared only when `GITHUB_REVIEWER_APP_ID` is set.
 */
export const REQUIRED_CHECKS = ["checks", "browser", "merge-gate", "reviewer-agent"] as const;

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
  "want",
] as const;
