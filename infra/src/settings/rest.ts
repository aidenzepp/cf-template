import { Config, Console, Effect, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import type { HttpMethod } from "effect/http/HttpMethod";
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
 * A JSON request body.
 */
type RequestBody = Schema.JsonObject;

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
  readonly goneIsApplied?: boolean;
}

/**
 * The body that turns one `security_and_analysis` feature on.
 *
 * @param key - The feature key, such as `secret_scanning`.
 * @returns The `PATCH /repos/{owner}/{repo}` body.
 */
const analysis = (key: string) => ({ security_and_analysis: { [key]: { status: "enabled" } } });

/**
 * The GitHub default labels the declaration does not name.
 */
const DEFAULT_LABELS = [
  "duplicate",
  "good first issue",
  "help wanted",
  "invalid",
  "question",
  "wontfix",
] as const;

/**
 * Build the settings calls for a repository, in the order they run.
 *
 * Endpoints and bodies, from the GitHub REST docs: "Update a repository"
 * (`PATCH /repos/{owner}/{repo}`), "Enable vulnerability alerts" (`PUT .../vulnerability-alerts`),
 * "Disable Dependabot security updates" (`DELETE .../automated-security-fixes`), "Update a code
 * scanning default setup configuration" (`PATCH .../code-scanning/default-setup`), "Enable private
 * vulnerability reporting" (`PUT .../private-vulnerability-reporting`), "Set GitHub Actions
 * permissions" (`PUT .../actions/permissions`), "Set default workflow permissions"
 * (`PUT .../actions/permissions/workflow`), "Set the fork PR contributor approval permissions"
 * (`PUT .../actions/permissions/fork-pr-contributor-approval`) and "Delete a label"
 * (`DELETE .../labels/{name}`).
 *
 * @param slug - The `owner/repo` path segment.
 * @returns The calls.
 */
const callsFor = (slug: string): ReadonlyArray<Call> => {
  const repo = `/repos/${slug}`;

  return [
    {
      body: {
        allow_merge_commit: false,
        allow_rebase_merge: false,
        allow_squash_merge: true,
        allow_update_branch: true,
        delete_branch_on_merge: true,
        pull_request_creation_policy: "collaborators_only",
        squash_merge_commit_message: "PR_BODY",
        squash_merge_commit_title: "PR_TITLE",
      },
      method: "PATCH",
      need: "mergeSettings",
      path: repo,
      setting: "merge-settings",
    },
    {
      body: { allow_auto_merge: true },
      method: "PATCH",
      need: "autoMerge",
      path: repo,
      setting: "auto-merge",
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
    ...DEFAULT_LABELS.map((label) => ({
      goneIsApplied: true,
      method: "DELETE" as const,
      path: `${repo}/labels/${encodeURIComponent(label)}`,
      setting: `delete-label ${label}`,
    })),
  ];
};

/**
 * The ruleset the program owns once an analysis exists: CodeQL results gate the default branch.
 * Body from "Create a repository ruleset", rule type `code_scanning`.
 */
const CODE_SCANNING_RULESET = {
  conditions: { ref_name: { exclude: [], include: ["~DEFAULT_BRANCH"] } },
  enforcement: "active",
  name: "code-scanning",
  rules: [
    {
      parameters: {
        code_scanning_tools: [
          {
            alerts_threshold: "errors",
            security_alerts_threshold: "high_or_higher",
            tool: "CodeQL",
          },
        ],
      },
      type: "code_scanning",
    },
  ],
  target: "branch",
} as const;

const RULESET = "code-scanning-ruleset";

const Rulesets = Schema.Array(Schema.Struct({ id: Schema.Number, name: Schema.String }));

type Kind = keyof RestSummary;

/**
 * Sort an HTTP status into an outcome. 2xx applies; 403 and 422 mean the tier or plan lacks the
 * feature; a 404 on a delete means the thing is already gone.
 *
 * @param status - The response status, or 0 when the transport failed.
 * @param goneIsApplied - Whether 404 counts as applied.
 * @returns The outcome kind.
 */
const classify = (status: number, goneIsApplied = false): Kind => {
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
const report = (kind: Kind, setting: string, status: number | "tier") =>
  Console.log(`${kind} ${setting} ${status === 0 ? "error" : status}`).pipe(Effect.as(kind));

/**
 * Run every settings call the tier allows, print one outcome line each, and total them.
 *
 * A failed call never stops the rest. When any call failed the run ends in a
 * {@link RestSettingsError} carrying the counts. The `code-scanning` ruleset is created or updated
 * only when `GET .../code-scanning/analyses` finds an analysis on `main`; otherwise the run prints
 * `PENDING code-scanning ruleset: no analysis on main yet`.
 *
 * @param repository - The guarded repository.
 * @param tier - The detected tier whose capabilities gate each call.
 * @returns The counts, or a {@link RestSettingsError} when any call failed.
 */
export const applyRest = Effect.fn("applyRest")(function* applyRest(
  repository: GuardedRepository,
  tier: Pick<Tier, "capabilities">,
) {
  const token = yield* Config.Redacted("GITHUB_TOKEN");
  const slug = `${repository.owner}/${repository.name}`;

  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.mapRequest((request) =>
      request.pipe(
        HttpClientRequest.prependUrl("https://api.github.com"),
        HttpClientRequest.acceptJson,
        HttpClientRequest.bearerToken(token),
      ),
    ),
  );

  const send = (method: HttpMethod, path: string, body?: RequestBody) =>
    client.execute(
      body === undefined
        ? HttpClientRequest.make(method)(path)
        : HttpClientRequest.make(method)(path).pipe(HttpClientRequest.bodyJsonUnsafe(body)),
    );

  const run = (call: Call) =>
    call.need !== undefined && !tier.capabilities.has(call.need)
      ? report("unavailable", call.setting, "tier")
      : send(call.method, call.path, call.body).pipe(
          Effect.map((response) => response.status),
          Effect.orElseSucceed(() => 0),
          Effect.flatMap((status) =>
            report(classify(status, call.goneIsApplied), call.setting, status),
          ),
        );

  const upsertCodeScanning = Effect.gen(function* upsert() {
    const analyses = yield* send(
      "GET",
      `/repos/${slug}/code-scanning/analyses?ref=refs%2Fheads%2Fmain&per_page=1`,
    );

    // GitHub answers 404 "no analysis found" (or 403 without code scanning) before the first one.
    if (![200, 403, 404].includes(analyses.status)) {
      return [yield* report("failed", RULESET, analyses.status)];
    }

    const present =
      analyses.status === 200 &&
      (yield* HttpClientResponse.schemaBodyJson(Schema.Array(Schema.Unknown))(analyses)).length > 0;

    if (!present) {
      return yield* Console.log("PENDING code-scanning ruleset: no analysis on main yet").pipe(
        Effect.as([]),
      );
    }

    const path = `/repos/${slug}/rulesets`;
    const existing = yield* send("GET", `${path}?per_page=100`);

    const found = (yield* HttpClientResponse.schemaBodyJson(Rulesets)(existing)).find(
      (ruleset) => ruleset.name === CODE_SCANNING_RULESET.name,
    );

    const written = yield* found === undefined
      ? send("POST", path, CODE_SCANNING_RULESET)
      : send("PUT", `${path}/${found.id}`, CODE_SCANNING_RULESET);

    return [yield* report(classify(written.status), RULESET, written.status)];
  }).pipe(Effect.catch(() => report("failed", RULESET, 0).pipe(Effect.map((kind) => [kind]))));

  const kinds = yield* Effect.forEach(callsFor(slug), run);

  const ruleset = tier.capabilities.has("rulesets")
    ? yield* upsertCodeScanning
    : [yield* report("unavailable", RULESET, "tier")];

  const all = [...kinds, ...ruleset];
  const count = (kind: Kind) => all.filter((value) => value === kind).length;

  const summary = {
    applied: count("applied"),
    failed: count("failed"),
    unavailable: count("unavailable"),
  };

  return summary.failed === 0
    ? (summary satisfies RestSummary)
    : yield* new RestSettingsError({
        ...summary,
        message: `${summary.failed} settings call(s) failed; ${summary.applied} applied, ${summary.unavailable} unavailable.`,
      });
});
