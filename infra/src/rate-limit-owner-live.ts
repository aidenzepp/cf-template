import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareApiLive } from "@alchemy.run/cloudflare/Providers";
import * as rulesets from "@distilled.cloud/cloudflare/rulesets";
import { BunServices } from "@effect/platform-bun";
import { AuthProvidersLive } from "alchemy/Auth/Registry";
import { Effect, Layer, Option, Predicate } from "effect";
import { FetchHttpClient } from "effect/http";
import { RateLimitEntrypoint, RateLimitEntrypointError } from "./rate-limit-owner.ts";
import type { EntrypointRule, ZoneEntrypoint, ZoneRef } from "./rate-limit-owner.ts";

/**
 * What every refusal of the guard ends with: the credentials the two reads need.
 */
const NEEDS = "The credentials need Zone Read and Zone WAF Read on the zone.";

/**
 * The Cloudflare error code of a ruleset that does not exist, which is how an entrypoint that was
 * never created reads. `RulesetNotFound` also matches code 10001, which covers internal errors,
 * authentication failures and a token that may not make the call, so only this code means absent.
 */
const ABSENT_ENTRYPOINT_CODE = 10_003;

/**
 * Wrap a failure of `operation` as a {@link RateLimitEntrypointError} naming its tag, code and
 * message, never its request.
 */
const failed =
  (operation: string) =>
  (cause: unknown): RateLimitEntrypointError =>
    new RateLimitEntrypointError({
      message: `Refusing to deploy: Cloudflare ${operation} failed: ${Predicate.hasProperty(cause, "_tag") ? String(cause._tag) : "unknown error"}${Predicate.hasProperty(cause, "code") ? ` (code ${String(cause.code)})` : ""}${Predicate.hasProperty(cause, "message") ? `, ${String(cause.message)}` : ""}. ${NEEDS}`,
    });

/**
 * The rules of an entrypoint read, with an absent entrypoint as no rules.
 *
 * Only a `RulesetNotFound` with code {@link ABSENT_ENTRYPOINT_CODE} is absent. Any other failure,
 * including `RulesetNotFound` with code 10001, stays a failure, so a read that did not happen never
 * passes the guard.
 *
 * @param phase - The entrypoint read.
 * @returns The rules of the entrypoint, none when it is absent.
 */
export const entrypointRules = <E, R>(
  phase: Effect.Effect<
    {
      readonly rules?: ReadonlyArray<{
        readonly id?: string | null;
        readonly ref?: string | null;
      }> | null;
    },
    E,
    R
  >,
): Effect.Effect<ReadonlyArray<EntrypointRule>, E, R> =>
  phase.pipe(
    Effect.map((entrypoint) => entrypoint.rules ?? []),
    Effect.catchIf(
      (error) => error instanceof rulesets.RulesetNotFound && error.code === ABSENT_ENTRYPOINT_CODE,
      () => Effect.succeed([]),
    ),
    Effect.map((rules) =>
      rules.map((rule) => ({ id: rule.id ?? "unknown", ref: rule.ref ?? undefined })),
    ),
  );

/**
 * The two Cloudflare reads behind {@link readZoneEntrypoint}.
 */
export interface EntrypointSource {
  /**
   * The zone of `hostname` in the account, if there is one.
   */
  readonly findZone: (
    hostname: string,
  ) => Effect.Effect<Option.Option<ZoneRef>, RateLimitEntrypointError>;
  /**
   * The rules of the `http_ratelimit` entrypoint of `zone`, none when it is absent.
   */
  readonly readRules: (
    zone: ZoneRef,
  ) => Effect.Effect<ReadonlyArray<EntrypointRule>, RateLimitEntrypointError>;
}

/**
 * The zone of `hostname` and the rules of its entrypoint, from `source`.
 *
 * @param source - The two reads.
 * @param hostname - The attached hostname.
 * @param variable - The variable the hostname came from, named in the error when no zone holds it.
 * @returns The zone and its rules, or a {@link RateLimitEntrypointError} when no zone of the
 *   account holds `hostname` or a read failed.
 */
export const readZoneEntrypoint = Effect.fn("readZoneEntrypoint")(function* readZoneEntrypoint(
  source: EntrypointSource,
  hostname: string,
  variable: string,
): Effect.fn.Return<ZoneEntrypoint, RateLimitEntrypointError> {
  const found = yield* source.findZone(hostname);

  if (Option.isNone(found)) {
    return yield* new RateLimitEntrypointError({
      message: `Refusing to deploy: no zone of this account holds ${hostname}, so its rate-limit entrypoint cannot be checked. Set ${variable} to a hostname of an active zone in the account the deploy credentials belong to. ${NEEDS}`,
    });
  }

  return { rules: yield* source.readRules(found.value), zone: found.value };
});

/**
 * The real read: Alchemy's authenticated Cloudflare layer, which resolves the profile or the CI
 * environment on first use, behind the zone lookup of `@alchemy.run/cloudflare` and the phase read
 * of `@distilled.cloud/cloudflare`.
 *
 * The undocumented subpaths this depends on are `@alchemy.run/cloudflare/Providers`
 * (`CloudflareApiLive`), `alchemy/Auth/Registry` (`AuthProvidersLive`) and
 * `@distilled.cloud/cloudflare/rulesets`. It reads nothing but the zone and its entrypoint, and
 * never reads, parses or prints a profile, a token or an account id source.
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

    const source: EntrypointSource = {
      findZone: (hostname) =>
        call("zone lookup", (accountId) =>
          Effect.gen(function* lookup() {
            for (const name of Cloudflare.Zone.zoneNameCandidates(hostname)) {
              const match = yield* Cloudflare.Zone.findZoneByName({ accountId, name });

              if (match !== undefined) {
                return Option.some({ id: match.id, name: match.name } satisfies ZoneRef);
              }
            }

            return Option.none<ZoneRef>();
          }),
        ),
      readRules: (zone) =>
        call("rate-limit entrypoint read", () =>
          entrypointRules(
            rulesets.getPhasForZone({ rulesetPhase: "http_ratelimit", zoneId: zone.id }),
          ),
        ),
    };

    return RateLimitEntrypoint.of({
      read: (hostname, variable) => readZoneEntrypoint(source, hostname, variable),
    });
  }),
);
