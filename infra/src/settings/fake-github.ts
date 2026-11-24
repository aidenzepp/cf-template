import { ConfigProvider, Console, Effect, Layer } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import type { GuardedRepository } from "./repository.ts";
import { CODE_SCANNING_RULESET } from "./rest-labels.ts";
import type { Capability } from "./tier.ts";

/**
 * The repository every fake run targets.
 */
const repository: GuardedRepository = {
  name: "widget",
  owner: "acme",
  ownerType: "User",
  visibility: "private",
};

/**
 * The capabilities of a private Pro repository.
 */
export const PRO = [
  "mergeSettings",
  "dependabotAlerts",
  "actionsSettings",
  "rulesets",
  "classicProtection",
  "autoMerge",
  "environments",
  "environmentSecrets",
  "shaPin",
] as const;

/**
 * The capabilities of a public repository: Pro plus the code-security features.
 */
export const PUBLIC = [
  ...PRO,
  "forkApproval",
  "privateVulnerabilityReporting",
  "environmentReviewers",
  "secretScanning",
  "pushProtection",
  "codeql",
] as const;

/**
 * The API path of {@link repository}.
 */
export const base = "/repos/acme/widget";

/**
 * A canned reply: a status and an optional JSON body.
 */
export interface Reply {
  readonly status: number;
  readonly body?: unknown;
}

/**
 * One request the fake received: its `METHOD path` and its parsed JSON body, if it had one.
 */
export interface Recorded {
  readonly call: string;
  readonly body: unknown;
}

/**
 * The reads of a repository whose REST-owned settings, the labels and the code-scanning ruleset
 * already hold every declared value, keyed by `METHOD path`. {@link converged} answers from it.
 */
const CONVERGED = new Map<string, Reply>([
  [
    `GET ${base}`,
    {
      body: {
        allow_update_branch: true,
        pull_request_creation_policy: "collaborators_only",
        security_and_analysis: {
          secret_scanning: { status: "enabled" },
          secret_scanning_push_protection: { status: "enabled" },
        },
        squash_merge_commit_message: "PR_BODY",
        squash_merge_commit_title: "PR_TITLE",
      },
      status: 200,
    },
  ],
  [`GET ${base}/vulnerability-alerts`, { status: 204 }],
  [
    `GET ${base}/automated-security-fixes`,
    { body: { enabled: false, paused: false }, status: 200 },
  ],
  [
    `GET ${base}/code-scanning/default-setup`,
    { body: { languages: [], query_suite: "default", state: "configured" }, status: 200 },
  ],
  [`GET ${base}/private-vulnerability-reporting`, { body: { enabled: true }, status: 200 }],
  [
    `GET ${base}/actions/permissions`,
    { body: { allowed_actions: "all", enabled: true, sha_pinning_required: true }, status: 200 },
  ],
  [
    `GET ${base}/actions/permissions/workflow`,
    {
      body: { can_approve_pull_request_reviews: false, default_workflow_permissions: "read" },
      status: 200,
    },
  ],
  [
    `GET ${base}/actions/permissions/fork-pr-contributor-approval`,
    { body: { approval_policy: "all_external_contributors" }, status: 200 },
  ],
  [`GET ${base}/code-scanning/analyses`, { body: [{ id: 1 }], status: 200 }],
  [`GET ${base}/rulesets/7`, { body: { ...CODE_SCANNING_RULESET, id: 7 }, status: 200 }],
]);

/**
 * Answer as a repository that already holds every value the settings program declares: each
 * REST-owned setting reads as declared, the seven default labels are gone (404), an analysis
 * exists on `main`, and the one repository ruleset is the declared `code-scanning` ruleset.
 *
 * @param call - The `METHOD path` of the request.
 * @param search - The query string of the request.
 * @returns The reply, or `undefined` for the default.
 */
export const converged = (call: string, search: string): Reply | undefined => {
  if (call.startsWith(`DELETE ${base}/labels/`)) {
    return { body: { message: "Not Found" }, status: 404 };
  }

  if (call === `GET ${base}/rulesets`) {
    return {
      body:
        new URLSearchParams(search).get("page") === "1" ? [{ id: 7, name: "code-scanning" }] : [],
      status: 200,
    };
  }

  return CONVERGED.get(call);
};

/**
 * Run a settings effect against a fake GitHub that records every request and printed line.
 *
 * @param runWith - Builds the effect from the repository and capability set.
 * @param capabilities - The tier's capabilities.
 * @param answer - The reply per `METHOD path`, query string and the requests recorded so far;
 *   return `undefined` for the default. The default is 204 with no body, except that a read of
 *   `vulnerability-alerts` answers 404 (off), so no setting reads as already declared.
 * @param environment - Extra configuration entries, such as `GITHUB_REPOSITORY`.
 * @returns The run, the recorded `METHOD path` list with bodies, and the printed lines.
 */
export const harness = <A, E>(
  runWith: (
    target: GuardedRepository,
    tier: { readonly capabilities: ReadonlySet<Capability> },
  ) => Effect.Effect<A, E, HttpClient.HttpClient>,
  capabilities: ReadonlyArray<Capability>,
  answer?: (call: string, search: string, recorded: ReadonlyArray<Recorded>) => Reply | undefined,
  environment: Record<string, string> = {},
) => {
  const requests: Array<Recorded> = [];
  const lines: Array<string> = [];

  const client = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url) =>
      Effect.sync(() => {
        const call = `${request.method} ${url.pathname}`;

        const body: unknown =
          request.body._tag === "Uint8Array"
            ? JSON.parse(new TextDecoder().decode(request.body.body))
            : undefined;

        requests.push({ body, call });

        const reply =
          answer?.(call, url.search, requests) ??
          (call === `GET ${base}/vulnerability-alerts` ? { status: 404 } : { status: 204 });

        return HttpClientResponse.fromWeb(
          request,
          new Response(reply.status === 204 ? null : JSON.stringify(reply.body ?? {}), {
            status: reply.status,
          }),
        );
      }),
    ),
  );

  const config = ConfigProvider.layer(
    ConfigProvider.fromUnknown({ GITHUB_TOKEN: "ghp_secret", ...environment }),
  );

  const run = runWith(repository, { capabilities: new Set(capabilities) }).pipe(
    Effect.provide([client, config]),
    Effect.provideService(Console.Console, {
      ...globalThis.console,
      log: (...args: ReadonlyArray<unknown>) => {
        lines.push(args.join(" "));
      },
    }),
  );

  return { lines, requests, run };
};
