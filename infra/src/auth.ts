import type * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import { Config, ConfigProvider, Effect, Layer, Option, Path, Schema } from "effect";
import { AUTH_ORPHAN_GRACE_SECONDS } from "@workspace/config/auth-orphan-grace";
import { AUTH_PASSWORD_SCRYPT } from "@workspace/config/auth-password";
import { AuthMethods } from "@workspace/config/auth-methods";
import { limitKnobs, limitsFor } from "@workspace/config/limits";
import { PublicOrigin } from "@workspace/config/public-origin";
import { Auth } from "../../apps/auth/src/contract.ts";
import { declareDatabase } from "../../apps/auth/src/db/database.ts";
import { EMAIL_KEY_SECRET_ID } from "../../apps/auth/src/email-key.ts";
import AuthWorker, { AuthDeployment } from "../../apps/auth/src/worker.ts";
import { kindOf, workerName } from "../stages.ts";
import type { StageName, StageValues } from "../stages.ts";
import { compat } from "./compat.ts";
import type { publicOrigin } from "./origin.ts";
import { issuesObservability, telemetryOptions } from "./telemetry.ts";

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
 * The `oAuthProxy` bindings of one stage, `OAUTH_PROXY_PRODUCTION_URL` and `OAUTH_PROXY_SECRET`.
 *
 * `prod` binds its own origin when the deployer sets `OAUTH_PROXY_SECRET`: it runs the plugin
 * before any preview, as the one callback host each provider registers. A `staging-<N>` preview
 * binds the deployer's `PROD_ORIGIN`, decoded as a `PublicOrigin`, when both `PROD_ORIGIN` and
 * `OAUTH_PROXY_SECRET` are set; a malformed `PROD_ORIGIN` fails the deploy through the `Config`
 * error channel. Either one absent binds nothing. `local` and `test-…` stages bind nothing,
 * whatever the deployer sets.
 *
 * @param stage - The decoded stage.
 * @param origin - The stage's public origin.
 * @returns The bindings to merge into the Worker's `env`.
 */
export const oauthProxyBindings = Effect.fn("oauthProxyBindings")(function* oauthProxyBindings(
  stage: StageName,
  origin: string,
) {
  const kind = kindOf(stage);

  if (kind !== "prod" && kind !== "staging") {
    return {};
  }

  const secret = yield* Config.option(Config.Redacted("OAUTH_PROXY_SECRET"));

  const productionURL =
    kind === "prod"
      ? Option.some(origin)
      : yield* Config.option(Config.schema(PublicOrigin, "PROD_ORIGIN"));

  return Option.match(Option.all({ productionURL, secret }), {
    onNone: () => ({}),
    onSome: (value) => ({
      OAUTH_PROXY_PRODUCTION_URL: value.productionURL,
      OAUTH_PROXY_SECRET: value.secret,
    }),
  });
});

/**
 * Declare the auth D1 database and the `auth` Worker with its bindings.
 *
 * The Worker binds `PUBLIC_ORIGIN`, `AUTH_METHODS`, the two cookie-cache values and the scrypt cost
 * from the stage's row, and `BETTER_AUTH_SECRET` and `EMAIL_KEY_SECRET`, each an `Alchemy.Random`
 * per stage that only `auth` reads, and the {@link oauthProxyBindings} of the stage. It keeps no
 * `workers.dev` address, domain or route. The D1 binding is made by the Worker's own program.
 *
 * @param identity - The stack name and decoded stage.
 * @param identity.stack - The stack name from `resolveStackName`.
 * @param identity.stage - The decoded stage.
 * @param hint - The `D1_PROD_LOCATION_HINT` knob value.
 * @param values - The knob values of the stage.
 * @param origin - The stage's public origin, computed once by the stack program and handed to
 *   `web` as well.
 * @returns The `auth` Worker resource.
 */
export const declareAuth = Effect.fn("declareAuth")(function* declareAuth(
  identity: { readonly stack: string; readonly stage: StageName },
  hint: Parameters<typeof declareDatabase>[2],
  values: StageValues,
  origin: Effect.Success<ReturnType<typeof publicOrigin>>,
) {
  const { stack, stage } = identity;
  const path = yield* Path.Path;
  yield* declareDatabase(stack, stage, hint);

  const secret = yield* Alchemy.Random("BetterAuthSecret");
  const emailKeySecret = yield* Alchemy.Random(EMAIL_KEY_SECRET_ID);
  const { methods, secrets } = yield* resolveMethods();
  const encodedMethods = yield* Schema.encodeEffect(Schema.fromJsonString(AuthMethods))(methods);
  const scrypt = yield* AUTH_PASSWORD_SCRYPT.encode(values.AUTH_PASSWORD_SCRYPT);
  const grace = yield* encodedOrphanGrace;
  const knobs = yield* limitKnobs;
  const proxy = yield* oauthProxyBindings(stage, origin);
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
      EMAIL_KEY_SECRET: emailKeySecret.text,
      LOG_LEVEL: values.LOG_LEVEL,
      PUBLIC_ORIGIN: origin,
      ...proxy,
      ...secrets,
    },
    limits: limitsFor("auth", { ...knobs, scrypt: values.AUTH_PASSWORD_SCRYPT }),
    main,
    name: yield* workerName({ stack, stage, worker: "auth" }),
    observability: issuesObservability,
    workersDev: false,
  } satisfies Cloudflare.WorkerProps;

  const telemetry = telemetryOptions(stage);

  return yield* Auth.pipe(
    Effect.provide(
      AuthWorker.pipe(Layer.provide(Layer.succeed(AuthDeployment, { props, telemetry }))),
    ),
  );
});
