import type { Schema } from "effect";
import type { HttpMethod } from "effect/http/HttpMethod";
import type { Capability } from "./tier.ts";

/**
 * One idempotent settings call. `need` is the tier capability that must be present; without it the
 * call is not sent and is reported `unavailable`. `phrases` are extra unavailable wordings for this
 * call alone. `confirm` names a `security_and_analysis` key to read back after a 2xx: GitHub
 * answers 200 and ignores the change on a plan without the feature, so applied needs `enabled`.
 *
 * Before the write, `GET path` reads the setting. The call is not sent, and prints `unchanged`,
 * when that read answers 2xx and its JSON holds `expected` (see `holds` in `rest.ts`); `expected`
 * is the `body` unless the call names its own. A read that fails, or answers anything else, sends
 * the call. A call with neither `expected` nor `body` is unchanged when its read answers 2xx.
 */
export interface Call {
  readonly setting: string;
  readonly need?: Capability;
  readonly method: HttpMethod;
  readonly path: string;
  readonly body?: Schema.JsonObject;
  readonly expected?: Schema.JsonObject;
  readonly phrases?: ReadonlyArray<string>;
  readonly confirm?: string;
}

/**
 * The body that turns one `security_and_analysis` feature on.
 *
 * @param key - The feature key, such as `secret_scanning`.
 * @returns The `PATCH /repos/{owner}/{repo}` body.
 */
const analysis = (key: string) => ({ security_and_analysis: { [key]: { status: "enabled" } } });

/**
 * What GitHub says to a CodeQL default-setup call on a repository without code scanning: a 403
 * "Code scanning is not enabled for this repository. Please enable code scanning in the repository
 * settings." (observed on the public probe repository, 2026-11-11). It counts as `unavailable` for
 * that one call only, so the same phrase on any other setting stays `failed`.
 */
const CODEQL_UNAVAILABLE = ["is not enabled for this repository"] as const;

/**
 * Build the repository settings calls, in the order they run: only what `@alchemy.run/github`
 * (`Repository.ts`, `Ruleset.ts`, `Environment.ts`, `Label.ts`, `Variable.ts`) has no prop for.
 * Merge methods, delete-on-merge and auto-merge are `GitHub.Repository` props, not calls here.
 *
 * Endpoints and bodies, from the GitHub REST docs: "Update a repository"
 * (`PATCH /repos/{owner}/{repo}`), "Enable vulnerability alerts" (`PUT .../vulnerability-alerts`),
 * "Disable Dependabot security updates" (`DELETE .../automated-security-fixes`), "Update a code
 * scanning default setup configuration" (`PATCH .../code-scanning/default-setup`), "Enable private
 * vulnerability reporting" (`PUT .../private-vulnerability-reporting`), "Set GitHub Actions
 * permissions" (`PUT .../actions/permissions`), "Set default workflow permissions"
 * (`PUT .../actions/permissions/workflow`) and "Set the fork PR contributor approval permissions"
 * (`PUT .../actions/permissions/fork-pr-contributor-approval`).
 *
 * @param slug - The `owner/repo` path segment.
 * @returns The calls.
 */
export const callsFor = (slug: string) => {
  const repo = `/repos/${slug}`;

  const calls: ReadonlyArray<Call> = [
    {
      body: {
        allow_update_branch: true,
        pull_request_creation_policy: "collaborators_only",
        squash_merge_commit_message: "PR_BODY",
        squash_merge_commit_title: "PR_TITLE",
      },
      method: "PATCH",
      need: "mergeSettings",
      path: repo,
      setting: "merge-extras",
    },
    {
      body: analysis("secret_scanning"),
      confirm: "secret_scanning",
      method: "PATCH",
      need: "secretScanning",
      path: repo,
      setting: "secret-scanning",
    },
    {
      body: analysis("secret_scanning_push_protection"),
      confirm: "secret_scanning_push_protection",
      method: "PATCH",
      need: "pushProtection",
      path: repo,
      setting: "push-protection",
    },
    {
      method: "PUT",
      need: "dependabotAlerts",
      path: `${repo}/vulnerability-alerts`,
      setting: "dependabot-alerts",
    },
    {
      expected: { enabled: false },
      method: "DELETE",
      need: "dependabotAlerts",
      path: `${repo}/automated-security-fixes`,
      setting: "dependabot-security-updates-off",
    },
    {
      body: { query_suite: "default", state: "configured" },
      method: "PATCH",
      need: "codeql",
      path: `${repo}/code-scanning/default-setup`,
      phrases: CODEQL_UNAVAILABLE,
      setting: "codeql-default-setup",
    },
    {
      expected: { enabled: true },
      method: "PUT",
      need: "privateVulnerabilityReporting",
      path: `${repo}/private-vulnerability-reporting`,
      setting: "private-vulnerability-reporting",
    },
    {
      body: { enabled: true, sha_pinning_required: true },
      method: "PUT",
      need: "shaPin",
      path: `${repo}/actions/permissions`,
      setting: "sha-pinning-required",
    },
    {
      body: { can_approve_pull_request_reviews: false, default_workflow_permissions: "read" },
      method: "PUT",
      need: "actionsSettings",
      path: `${repo}/actions/permissions/workflow`,
      setting: "workflow-permissions",
    },
    {
      body: { approval_policy: "all_external_contributors" },
      method: "PUT",
      need: "forkApproval",
      path: `${repo}/actions/permissions/fork-pr-contributor-approval`,
      setting: "fork-approval",
    },
  ];

  return calls;
};
