import { Effect, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import type { HttpMethod } from "effect/http/HttpMethod";
import { githubToken } from "./repository.ts";
import type { GuardedRepository } from "./repository.ts";
import { report, reportResponse, settle, summarize } from "./rest-outcome.ts";
import type { Outcome } from "./rest-outcome.ts";
import type { Capability, Tier } from "./tier.ts";

/**
 * A JSON request body.
 */
type RequestBody = Schema.JsonObject;

/**
 * One idempotent settings call. `need` is the tier capability that must be present; without it the
 * call is not sent and is reported `unavailable`. `phrases` are extra unavailable wordings for this
 * call alone. `confirm` names a `security_and_analysis` key to read back after a 2xx: GitHub
 * answers 200 and ignores the change on a plan without the feature, so applied needs `enabled`.
 */
interface Call {
  readonly setting: string;
  readonly need?: Capability;
  readonly method: HttpMethod;
  readonly path: string;
  readonly body?: RequestBody;
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
 * A GitHub REST sender: bearer-authenticated with `GITHUB_TOKEN`, rooted at `api.github.com`.
 */
export const restClient = Effect.gen(function* restClient() {
  const token = yield* githubToken;

  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.mapRequest((request) =>
      request.pipe(
        HttpClientRequest.prependUrl("https://api.github.com"),
        HttpClientRequest.acceptJson,
        HttpClientRequest.bearerToken(token),
      ),
    ),
  );

  return (method: HttpMethod, path: string, body?: RequestBody) =>
    client.execute(
      body === undefined
        ? HttpClientRequest.make(method)(path)
        : HttpClientRequest.make(method)(path).pipe(HttpClientRequest.bodyJsonUnsafe(body)),
    );
});

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
const callsFor = (slug: string): ReadonlyArray<Call> => {
  const repo = `/repos/${slug}`;

  return [
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
};

/**
 * Send a call, and when it applied, read the repository back: the call stays `applied` only if
 * `security_and_analysis[confirm].status` is `enabled`, otherwise it is `unavailable` ("silently
 * ignored by GitHub"). A failed read-back is `failed`.
 *
 * @param send - The REST sender.
 * @param call - The call; its `confirm` key is read back.
 * @param confirm - The `security_and_analysis` key to verify.
 * @returns The kind, after the outcome line is printed.
 */
const applyConfirmed = (send: Effect.Success<typeof restClient>, call: Call, confirm: string) =>
  send(call.method, call.path, call.body).pipe(
    Effect.flatMap((response) => settle(response, { gated: true, phrases: call.phrases })),
    Effect.filterOrElse(
      (outcome) => outcome.kind !== "applied",
      (outcome) =>
        send("GET", call.path).pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap(
            HttpClientResponse.schemaBodyJson(
              Schema.Struct({
                security_and_analysis: Schema.optional(
                  Schema.Record(
                    Schema.String,
                    Schema.Struct({ status: Schema.optional(Schema.String) }),
                  ),
                ),
              }),
            ),
          ),
          Effect.map((repository): Outcome =>
            repository.security_and_analysis?.[confirm]?.status === "enabled"
              ? outcome
              : {
                  detail: "silently ignored by GitHub",
                  kind: "unavailable",
                  status: outcome.status,
                },
          ),
        ),
    ),
    Effect.orElseSucceed((): Outcome => ({ kind: "failed", status: 0 })),
    Effect.flatMap(({ detail, kind, status }) => report(kind, call.setting, status, detail)),
  );

/**
 * Send one call and print its outcome line, reading the repository back when the call names a
 * `confirm` key.
 *
 * @param send - The REST sender.
 * @param call - The call.
 * @returns The kind, after the outcome line is printed.
 */
const sendCall = (send: Effect.Success<typeof restClient>, call: Call) =>
  call.confirm === undefined
    ? reportResponse(call.setting, send(call.method, call.path, call.body), {
        gated: call.need !== undefined,
        phrases: call.phrases,
      })
    : applyConfirmed(send, call, call.confirm);

/**
 * Run every repository settings call the tier allows, print one outcome line each, and total them.
 *
 * A failed call never stops the rest. A transport failure counts as `failed`. When any call failed
 * the run ends in a {@link RestSettingsError} carrying the counts.
 *
 * @param repository - The guarded repository.
 * @param tier - The detected tier whose capabilities gate each call.
 * @returns The counts, or a {@link RestSettingsError} when any call failed.
 */
export const applyRest = Effect.fn("applyRest")(function* applyRest(
  repository: GuardedRepository,
  tier: Pick<Tier, "capabilities">,
) {
  const send = yield* restClient;

  const kinds = yield* Effect.forEach(callsFor(`${repository.owner}/${repository.name}`), (call) =>
    call.need !== undefined && !tier.capabilities.has(call.need)
      ? report("unavailable", call.setting, "tier")
      : sendCall(send, call),
  );

  return yield* summarize(kinds);
});
