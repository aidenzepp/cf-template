import type * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import { Config, ConfigProvider, Effect, Layer, Option, Path, Schema } from "effect";
import { AUTH_PASSWORD_SCRYPT } from "@workspace/config/auth-password";
import { AuthMethods } from "@workspace/config/auth-methods";
import { PublicOrigin, WEB_DEV_PORT } from "@workspace/config/public-origin";
import { Auth } from "../../apps/auth/src/contract.ts";
import { declareDatabase } from "../../apps/auth/src/db/database.ts";
import { AUTH_ORPHAN_GRACE_SECONDS } from "../../apps/auth/src/reclaim.ts";
import AuthWorker, { AuthDeployment } from "../../apps/auth/src/worker.ts";
import { kindOf, workerName } from "../stages.ts";
import type { StageName, StageValues } from "../stages.ts";
import { compat } from "./compat.ts";
import { publicOrigin } from "./origin.ts";

/**
 * The refusal of a cloud stage whose `workers.dev` subdomain is unknown.
 */
export class WorkersSubdomainMissing extends Schema.TaggedError<WorkersSubdomainMissing>()(
  "WorkersSubdomainMissing",
  { stage: Schema.String },
) {
  override get message(): string {
    return `CLOUDFLARE_WORKERS_SUBDOMAIN is unset for stage ${this.stage}, so its public origin is unknown. Set it to the account's workers.dev subdomain.`;
  }
}

/**
 * Read the credential pair of one OAuth provider: `<PREFIX>_CLIENT_ID` with
 * `<PREFIX>_CLIENT_SECRET`.
 *
 * Both set yields `Some`, neither set yields `None`, and one alone fails through the `Config` error
 * channel, so the deploy stops before any resource is touched. An empty string reads as absent.
 *
 * @param prefix - The upper-case provider name, such as `GITHUB`.
 * @returns The pair, or `None` when the provider is not configured.
 */
const providerPair = (prefix: string) =>
  Config.all({
    id: Config.option(Config.Redacted(`${prefix}_CLIENT_ID`)),
    secret: Config.option(Config.Redacted(`${prefix}_CLIENT_SECRET`)),
  }).pipe(
    Config.mapEffect(({ id, secret }) => {
      if (Option.isSome(id) && Option.isSome(secret)) {
        return Effect.succeed(Option.some({ id: id.value, secret: secret.value }));
      }

      if (Option.isNone(id) && Option.isNone(secret)) {
        return Effect.succeed(Option.none());
      }

      const [set, missing] = Option.isSome(id)
        ? [`${prefix}_CLIENT_ID`, `${prefix}_CLIENT_SECRET`]
        : [`${prefix}_CLIENT_SECRET`, `${prefix}_CLIENT_ID`];

      return Effect.fail(
        new Config.ConfigError(
          new ConfigProvider.SourceError({
            message: `${set} is set but ${missing} is not. Set both to enable the provider, or neither to omit it.`,
          }),
        ),
      );
    }),
  );

/**
 * The credential pair of every provider, read once at deploy.
 */
export const providerCredentials = Config.all({
  github: providerPair("GITHUB"),
  google: providerPair("GOOGLE"),
});

/**
 * Evaluate which providers are live from their credential pairs.
 *
 * @returns The sign-in methods, the provider ids in schema order with the mail add-in off, and the
 *   bindings of each live provider's pair. `email` stays false until the mail add-in's attach line
 *   exists in `infra/alchemy.run.ts`.
 */
export const resolveMethods = Effect.fn("resolveMethods")(function* resolveMethods() {
  const pairs = yield* providerCredentials;

  const live = (
    [
      ["github", "GITHUB", pairs.github],
      ["google", "GOOGLE", pairs.google],
    ] as const
  ).flatMap(([id, prefix, pair]) =>
    Option.isSome(pair) ? [{ id, pair: pair.value, prefix }] : [],
  );

  const methods: typeof AuthMethods.Type = { email: false, providers: live.map(({ id }) => id) };

  const secrets = Object.fromEntries(
    live.flatMap(({ pair, prefix }) => [
      [`${prefix}_CLIENT_ID`, pair.id],
      [`${prefix}_CLIENT_SECRET`, pair.secret],
    ]),
  );

  return { methods, secrets };
});

/**
 * Compute the interim public origin of a stage: the `workers.dev` address of its `web` Worker on a
 * cloud stage, and the local dev server under the `local` kind.
 *
 * The custom-domain rule replaces this value later; this file stays its one producer.
 *
 * @param parts - The parts of the origin.
 * @param parts.stack - The stack name.
 * @param parts.stage - The decoded stage.
 * @param parts.subdomain - The account's `workers.dev` subdomain, `CLOUDFLARE_WORKERS_SUBDOMAIN`.
 * @returns The validated origin, or the failure of an unknown subdomain or a name that is too long.
 */
export const interimPublicOrigin = Effect.fn("interimPublicOrigin")(
  function* interimPublicOrigin(parts: {
    readonly stack: string;
    readonly stage: StageName;
    readonly subdomain: Option.Option<string>;
  }) {
    const decode = Schema.decodeUnknownEffect(PublicOrigin);

    if (kindOf(parts.stage) === "local") {
      return yield* decode(`http://localhost:${WEB_DEV_PORT}`);
    }

    if (Option.isNone(parts.subdomain)) {
      return yield* new WorkersSubdomainMissing({ stage: parts.stage });
    }

    const web = yield* workerName({ stack: parts.stack, stage: parts.stage, worker: "web" });

    return yield* decode(`https://${web}.${parts.subdomain.value}.workers.dev`);
  },
);

/**
 * The JSON text bound as `AUTH_METHODS`, on `auth` and on `web`. This file is its one producer.
 */
export const encodedAuthMethods = resolveMethods().pipe(
  Effect.flatMap(({ methods }) => Schema.encodeEffect(Schema.fromJsonString(AuthMethods))(methods)),
);

/**
 * The text bound as `AUTH_ORPHAN_GRACE_SECONDS`, on `auth` and on `web`: the knob's default, as no
 * stage row carries a value for it.
 */
export const encodedOrphanGrace = AUTH_ORPHAN_GRACE_SECONDS.encode(
  AUTH_ORPHAN_GRACE_SECONDS.default,
);

/**
 * The interim public origin of a stage, with the `workers.dev` subdomain read from
 * `CLOUDFLARE_WORKERS_SUBDOMAIN`. The one place that reads it, for `auth` and `web`.
 *
 * @param identity - The stack name and decoded stage.
 * @param identity.stack - The stack name.
 * @param identity.stage - The decoded stage.
 * @returns The validated origin, or the failure of {@link interimPublicOrigin}.
 */
export const resolvePublicOrigin = Effect.fn("resolvePublicOrigin")(
  function* resolvePublicOrigin(identity: { readonly stack: string; readonly stage: StageName }) {
    const subdomain = yield* Config.String("CLOUDFLARE_WORKERS_SUBDOMAIN").pipe(Config.option);

    return yield* interimPublicOrigin({ ...identity, subdomain });
  },
);

/**
 * Declare the auth D1 database and the `auth` Worker with its bindings.
 *
 * The Worker binds `PUBLIC_ORIGIN`, `AUTH_METHODS`, the two cookie-cache values and the scrypt cost
 * from the stage's row, and `BETTER_AUTH_SECRET`, an `Alchemy.Random` per stage that only `auth`
 * reads. It keeps no `workers.dev` address, domain or route. The D1 binding is made by the Worker's
 * own program.
 *
 * @param identity - The stack name and decoded stage.
 * @param identity.stack - The stack name from `resolveStackName`.
 * @param identity.stage - The decoded stage.
 * @param hint - The `D1_PROD_LOCATION_HINT` knob value.
 * @param values - The knob values of the stage.
 * @returns The `auth` Worker resource.
 */
export const declareAuth = Effect.fn("declareAuth")(function* declareAuth(
  identity: { readonly stack: string; readonly stage: StageName },
  hint: Parameters<typeof declareDatabase>[2],
  values: StageValues,
) {
  const { stack, stage } = identity;
  const path = yield* Path.Path;
  yield* declareDatabase(stack, stage, hint);

  const secret = yield* Alchemy.Random("BetterAuthSecret");
  const origin = yield* publicOrigin({ stack, stage });
  const { methods, secrets } = yield* resolveMethods();
  const encodedMethods = yield* Schema.encodeEffect(Schema.fromJsonString(AuthMethods))(methods);
  const scrypt = yield* AUTH_PASSWORD_SCRYPT.encode(values.AUTH_PASSWORD_SCRYPT);
  const grace = yield* encodedOrphanGrace;
  const main = yield* path.fromFileUrl(new URL("../../apps/auth/src/worker.ts", import.meta.url));

  const props = {
    compatibility: { date: compat.date, flags: compat.flags.map((flag) => flag.name) },
    env: {
      AUTH_COOKIE_CACHE_MAX_AGE_S: values.AUTH_COOKIE_CACHE_MAX_AGE_S,
      AUTH_COOKIE_CACHE_STRATEGY: values.AUTH_COOKIE_CACHE_STRATEGY,
      AUTH_METHODS: encodedMethods,
      AUTH_ORPHAN_GRACE_SECONDS: grace,
      AUTH_PASSWORD_SCRYPT: scrypt,
      BETTER_AUTH_SECRET: secret.text,
      LOG_LEVEL: values.LOG_LEVEL,
      PUBLIC_ORIGIN: origin,
      ...secrets,
    },
    main,
    name: yield* workerName({ stack, stage, worker: "auth" }),
    workersDev: false,
  } satisfies Cloudflare.WorkerProps;

  return yield* Auth.pipe(
    Effect.provide(AuthWorker.pipe(Layer.provide(Layer.succeed(AuthDeployment, { props })))),
  );
});
