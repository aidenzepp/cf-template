import { Console, Effect, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import type { HttpMethod } from "effect/http/HttpMethod";
import { githubToken } from "./repository.ts";
import type { GuardedRepository } from "./repository.ts";
import type { Capability, Tier } from "./tier.ts";

/**
 * The counts of one run, in the shape `reportLine` prints (`applied`, `unavailable`).
 */
export interface RestSummary {
  readonly applied: number;
  readonly unavailable: number;
  readonly failed: number;
}

/**
 * The failure at the end of a run in which at least one call failed. Every other call still ran.
 */
export class RestSettingsError extends Schema.TaggedError<RestSettingsError>()(
  "RestSettingsError",
  {
    applied: Schema.Number,
    failed: Schema.Number,
    message: Schema.String,
    unavailable: Schema.Number,
  },
) {}

/**
 * The outcome of one call: the {@link RestSummary} counter it adds to.
 */
export type Kind = keyof RestSummary;

/**
 * A JSON request body.
 */
export type RequestBody = Schema.JsonObject;

/**
 * One idempotent settings call. `need` is the tier capability that must be present; without it the
 * call is not sent and is reported `unavailable`.
 */
interface Call {
  readonly setting: string;
  readonly need?: Capability;
  readonly method: HttpMethod;
  readonly path: string;
  readonly body?: RequestBody;
}

/**
 * The body that turns one `security_and_analysis` feature on.
 *
 * @param key - The feature key, such as `secret_scanning`.
 * @returns The `PATCH /repos/{owner}/{repo}` body.
 */
const analysis = (key: string) => ({ security_and_analysis: { [key]: { status: "enabled" } } });

/**
 * Sort an HTTP status into an outcome. 2xx applies; 403 and 422 mean the tier or plan lacks the
 * feature; a 404 where `goneIsApplied` is set means the thing is already gone.
 *
 * @param status - The response status, or 0 when the transport failed.
 * @param goneIsApplied - Whether 404 counts as applied.
 * @returns The outcome kind.
 */
export const classify = (status: number, goneIsApplied = false): Kind => {
  if ((status >= 200 && status < 300) || (goneIsApplied && status === 404)) {
    return "applied";
  }

  return status === 403 || status === 422 ? "unavailable" : "failed";
};

/**
 * Print one outcome line and return its kind.
 *
 * @param kind - The outcome.
 * @param setting - The setting's name.
 * @param status - The HTTP status, 0 for a transport failure, or `tier` when the call was skipped.
 * @returns The kind, after the line is printed.
 */
export const report = (kind: Kind, setting: string, status: number | "tier") =>
  Console.log(`${kind} ${setting} ${status === 0 ? "error" : status}`).pipe(Effect.as(kind));

/**
 * Total the outcomes of a run. Any failure ends the run in a {@link RestSettingsError} that carries
 * the same counts.
 *
 * @param kinds - One outcome per call.
 * @returns The counts, or a {@link RestSettingsError} when any call failed.
 */
export const summarize = (kinds: ReadonlyArray<Kind>) => {
  const count = (kind: Kind) => kinds.filter((value) => value === kind).length;

  const summary = {
    applied: count("applied"),
    failed: count("failed"),
    unavailable: count("unavailable"),
  };

  return summary.failed === 0
    ? Effect.succeed(summary satisfies RestSummary)
    : Effect.fail(
        new RestSettingsError({
          ...summary,
          message: `${summary.failed} settings call(s) failed; ${summary.applied} applied, ${summary.unavailable} unavailable.`,
        }),
      );
};

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
      method: "PATCH",
      need: "secretScanning",
      path: repo,
      setting: "secret-scanning",
    },
    {
      body: analysis("secret_scanning_push_protection"),
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
      setting: "codeql-default-setup",
    },
    {
      method: "PUT",
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
      need: "actionsSettings",
      path: `${repo}/actions/permissions/fork-pr-contributor-approval`,
      setting: "fork-approval",
    },
  ];
};

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
      : send(call.method, call.path, call.body).pipe(
          Effect.map((response) => response.status),
          Effect.orElseSucceed(() => 0),
          Effect.flatMap((status) => report(classify(status), call.setting, status)),
        ),
  );

  return yield* summarize(kinds);
});
