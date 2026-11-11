import { Config, ConfigProvider, Effect, Option, Schema } from "effect";
import { CustomDomain, PublicOrigin, WEB_DEV_PORT } from "@workspace/config/public-origin";
import { kindOf, workerName } from "../stages.ts";
import type { StageName } from "../stages.ts";

/**
 * Read `CUSTOM_DOMAIN` for a stage: required on `prod`, optional on the `test` kind, rejected on
 * every other kind.
 *
 * A `test` stage honours the value only when the deploy environment sets it, so the owned-domain
 * proof can run on a throwaway slug; unset, it stays on `workers.dev`. A failure travels the
 * `Config` error channel, so a deploy stops before any resource is touched.
 *
 * @param stage - The decoded stage.
 * @returns The domain on `prod`, the domain on a `test` stage that sets one, and none elsewhere.
 */
export const customDomain = Effect.fn("customDomain")(function* customDomain(stage: StageName) {
  const kind = kindOf(stage);

  if (kind === "prod") {
    return Option.some(yield* Config.schema(CustomDomain, "CUSTOM_DOMAIN"));
  }

  if (kind === "test") {
    return yield* Config.schema(CustomDomain, "CUSTOM_DOMAIN").pipe(Config.option);
  }

  const supplied = yield* Config.String("CUSTOM_DOMAIN").pipe(Config.option);

  if (Option.isSome(supplied)) {
    return yield* Effect.fail(
      new Config.ConfigError(
        new ConfigProvider.SourceError({
          message: `CUSTOM_DOMAIN is set for stage ${stage}, but only prod and test stages honour it. Unset it.`,
        }),
      ),
    );
  }

  return Option.none<typeof CustomDomain.Type>();
});

/**
 * Compute the public origin of a stage once, for `web` and `auth` to bind as `PUBLIC_ORIGIN`.
 *
 * `prod` with a hostname in `CUSTOM_DOMAIN` is `https://<hostname>`. Every other cloud stage, and
 * `prod` with `workers-dev`, is the `workers.dev` address of its `web` Worker under
 * `CLOUDFLARE_WORKERS_SUBDOMAIN`. The `local` kind is `http://localhost:<WEB_DEV_PORT>`, a
 * constant.
 *
 * @param identity - The stack name and decoded stage.
 * @param identity.stack - The stack name from `resolveStackName`.
 * @param identity.stage - The decoded stage.
 * @returns The validated origin, or the failure of an invalid or misplaced `CUSTOM_DOMAIN`, a
 *   missing subdomain or a Worker name that is too long.
 */
export const publicOrigin = Effect.fn("publicOrigin")(function* publicOrigin(identity: {
  readonly stack: string;
  readonly stage: StageName;
}) {
  const decode = Schema.decodeUnknownEffect(PublicOrigin);
  const domain = yield* customDomain(identity.stage);

  if (kindOf(identity.stage) === "local") {
    return yield* decode(`http://localhost:${WEB_DEV_PORT}`);
  }

  if (Option.isSome(domain) && domain.value !== "workers-dev") {
    return yield* decode(`https://${domain.value}`);
  }

  const subdomain = yield* Config.String("CLOUDFLARE_WORKERS_SUBDOMAIN").pipe(
    Effect.mapError(
      () =>
        new Config.ConfigError(
          new ConfigProvider.SourceError({
            message: `CLOUDFLARE_WORKERS_SUBDOMAIN is unset for stage ${identity.stage}, so its public origin is unknown. Set it to the account's workers.dev subdomain, for example CLOUDFLARE_WORKERS_SUBDOMAIN=acme.`,
          }),
        ),
    ),
  );

  const web = yield* workerName({ ...identity, worker: "web" });

  return yield* decode(`https://${web}.${subdomain}.workers.dev`);
});
