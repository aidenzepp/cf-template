import { ConfigProvider, Console, Effect, Layer } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import type { GuardedRepository } from "./repository.ts";
import type { Capability } from "./tier.ts";

/**
 * The repository every fake run targets.
 */
export const repository: GuardedRepository = {
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
 * Run a settings effect against a fake GitHub that records every request and printed line.
 *
 * @param runWith - Builds the effect from the repository and capability set.
 * @param capabilities - The tier's capabilities.
 * @param answer - The reply per `METHOD path` and query string; return `undefined` for the default,
 *   204.
 * @returns The run, the recorded `METHOD path` list with bodies, and the printed lines.
 */
export const harness = <A, E>(
  runWith: (
    target: GuardedRepository,
    tier: { readonly capabilities: ReadonlySet<Capability> },
  ) => Effect.Effect<A, E, HttpClient.HttpClient>,
  capabilities: ReadonlyArray<Capability>,
  answer?: (call: string, search: string) => Reply | undefined,
) => {
  const requests: Array<{ readonly call: string; readonly body: unknown }> = [];
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

        const reply = answer?.(call, url.search) ?? { status: 204 };

        return HttpClientResponse.fromWeb(
          request,
          new Response(reply.status === 204 ? null : JSON.stringify(reply.body ?? {}), {
            status: reply.status,
          }),
        );
      }),
    ),
  );

  const config = ConfigProvider.layer(ConfigProvider.fromUnknown({ GITHUB_TOKEN: "ghp_secret" }));

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
