import type * as Cloudflare from "@alchemy.run/cloudflare";
import { Effect, Option } from "effect";
import type { StageName } from "../stages.ts";
import { customDomain } from "./origin.ts";

/**
 * How `web` is addressed: an owned hostname that turns `workers.dev` off, or the `workers.dev`
 * default. `domain` is `null` on the default, never omitted, so a detach converges explicitly.
 */
export type DomainConfig =
  | {
      readonly kind: "hostname";
      readonly hostname: string;
      readonly domain: string;
      readonly workersDev: false;
    }
  | {
      readonly kind: "workers-dev";
      readonly domain: null;
      readonly workersDev: { readonly enabled: true; readonly previewsEnabled: false };
    };

/**
 * Map the stage's decoded `CUSTOM_DOMAIN` to the `domain` and `workersDev` props of `web`.
 *
 * It adds no decoder: the value comes from {@link customDomain}, so only `prod` honours a hostname.
 *
 * @param stage - The decoded stage.
 * @returns The hostname form on `prod` with a hostname, else the `workers.dev` form.
 */
export const domainFor = Effect.fn("domainFor")(function* domainFor(
  stage: StageName,
): Effect.fn.Return<DomainConfig, Effect.Error<ReturnType<typeof customDomain>>> {
  const value = yield* customDomain(stage);

  if (Option.isSome(value) && value.value !== "workers-dev") {
    return { domain: value.value, hostname: value.value, kind: "hostname", workersDev: false };
  }

  return {
    domain: null,
    kind: "workers-dev",
    workersDev: { enabled: true, previewsEnabled: false },
  };
});

/**
 * The props of the one WAF rate-limit `Cloudflare.Ruleset` of an owned domain, without its `zone`.
 *
 * It blocks an IP for 10 s once it sends more than 50 requests in 10 s outside `/assets/`, before
 * a Worker runs. A Free zone keys a rule on the IP alone.
 *
 * @param hostname - The attached hostname, named in the rule's description.
 * @returns The `phase`, `rules` and `description` of the ruleset.
 */
export const wafRateLimitRule = (
  hostname: string,
): Omit<Cloudflare.Ruleset.RulesetProps, "zone"> => ({
  description: `Rate limit requests to ${hostname} outside /assets/ before a Worker is invoked`,
  phase: "http_ratelimit",
  rules: [
    {
      action: "block",
      description: "Block an IP above 50 requests per 10 s outside /assets/",
      enabled: true,
      expression: 'not starts_with(http.request.uri.path, "/assets/")',
      ratelimit: {
        characteristics: ["ip.src"],
        mitigationTimeout: 10,
        period: 10,
        requestsPerPeriod: 50,
      },
    },
  ],
});
