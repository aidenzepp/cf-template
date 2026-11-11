import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareApiLive } from "@alchemy.run/cloudflare/Providers";
import * as rulesets from "@distilled.cloud/cloudflare/rulesets";
import * as zones from "@distilled.cloud/cloudflare/zones";
import { BunServices } from "@effect/platform-bun";
import { AuthProvidersLive } from "alchemy/Auth/Registry";
import { Effect, Layer, Option, Predicate } from "effect";
import { FetchHttpClient } from "effect/http";
import { RateLimitEntrypoint, RateLimitEntrypointError } from "./rate-limit-owner.ts";
import type { ZoneRef } from "./rate-limit-owner.ts";

/**
 * Wrap a failure of `operation` as a {@link RateLimitEntrypointError} naming its tag and message,
 * never its request.
 */
const failed =
  (operation: string) =>
  (cause: unknown): RateLimitEntrypointError =>
    new RateLimitEntrypointError({
      message: `Cloudflare ${operation} failed: ${Predicate.hasProperty(cause, "_tag") ? String(cause._tag) : "unknown error"}${Predicate.hasProperty(cause, "message") ? `, ${String(cause.message)}` : ""}.`,
    });

/**
 * The names a hostname's zone can have, longest first: the hostname, then each parent with at
 * least two labels.
 *
 * @param hostname - The attached hostname.
 * @returns The candidate zone names.
 */
export const zoneNameCandidates = (hostname: string): ReadonlyArray<string> => {
  const labels = hostname.split(".");

  return labels
    .slice(0, Math.max(labels.length - 1, 1))
    .map((_, index) => labels.slice(index).join("."));
};

/**
 * The real read: Alchemy's authenticated Cloudflare layer, which resolves the profile or the CI
 * environment on first use, behind the zone listing and the phase read of
 * `@distilled.cloud/cloudflare`.
 *
 * The undocumented subpaths this depends on are `@alchemy.run/cloudflare/Providers`
 * (`CloudflareApiLive`), `alchemy/Auth/Registry` (`AuthProvidersLive`),
 * `@distilled.cloud/cloudflare/zones` and `@distilled.cloud/cloudflare/rulesets`. It reads
 * nothing but the zone and its entrypoint, and never reads, parses or prints a profile, a token or
 * an account id source.
 */
export const RateLimitEntrypointLive = Layer.effect(
  RateLimitEntrypoint,
  Effect.gen(function* buildRateLimitEntrypoint() {
    const context = yield* Layer.build(
      Layer.provide(
        CloudflareApiLive(),
        Layer.mergeAll(BunServices.layer, AuthProvidersLive, FetchHttpClient.layer),
      ),
    );

    const call = <A, E, R>(operation: string, run: (accountId: string) => Effect.Effect<A, E, R>) =>
      Cloudflare.CloudflareEnvironment.current.pipe(
        Effect.flatMap((environment) => run(environment.accountId)),
        Effect.provideContext(context),
        Effect.mapError(failed(operation)),
      );

    const findZone = (hostname: string) =>
      call("zone lookup", (accountId) =>
        Effect.gen(function* lookup() {
          for (const name of zoneNameCandidates(hostname)) {
            const page = yield* zones.listZones({ account: { id: accountId }, name, perPage: 1 });

            const match = (page.result ?? []).find(
              (zone) => zone.name === name && zone.account.id === accountId,
            );

            if (match !== undefined) {
              return Option.some({ id: match.id, name: match.name } satisfies ZoneRef);
            }
          }

          return Option.none<ZoneRef>();
        }),
      );

    return RateLimitEntrypoint.of({
      read: (hostname) =>
        Effect.gen(function* read() {
          const found = yield* findZone(hostname);

          if (Option.isNone(found)) {
            return yield* new RateLimitEntrypointError({
              message: `No zone of this account holds ${hostname}, so its rate-limit entrypoint cannot be checked. Set CUSTOM_DOMAIN to a hostname of an active zone in the same account.`,
            });
          }

          const zone = found.value;

          const entrypoint = yield* call("rate-limit entrypoint read", () =>
            rulesets
              .getPhasForZone({ rulesetPhase: "http_ratelimit", zoneId: zone.id })
              .pipe(Effect.catchTag("RulesetNotFound", () => Effect.undefined)),
          );

          return {
            rules: (entrypoint?.rules ?? []).map((rule) => ({
              id: rule.id ?? "unknown",
              ref: rule.ref ?? undefined,
            })),
            zone,
          };
        }),
    });
  }),
);
