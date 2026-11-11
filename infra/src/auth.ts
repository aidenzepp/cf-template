import type * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import { Config, Effect, Layer, Option, Path, Schema } from "effect";
import { AuthMethods } from "@workspace/config/auth-methods";
import { PublicOrigin, WEB_DEV_PORT } from "@workspace/config/public-origin";
import { Auth } from "../../apps/auth/src/contract.ts";
import { declareDatabase } from "../../apps/auth/src/db/database.ts";
import AuthWorker, { AuthDeployment } from "../../apps/auth/src/worker.ts";
import { kindOf, workerName } from "../stages.ts";
import type { StageName, StageValues } from "../stages.ts";
import { compat } from "./compat.ts";

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
 * The sign-in methods `auth` offers until the provider and mail blocks land: no OAuth provider and
 * no mail add-in. `infra` is the one producer; `auth` only reads the value.
 */
const METHODS: typeof AuthMethods.Type = { email: false, providers: [] };

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
 * Declare the auth D1 database and the `auth` Worker with its bindings.
 *
 * The Worker binds `PUBLIC_ORIGIN`, `AUTH_METHODS`, the two cookie-cache values from the stage's
 * row, and `BETTER_AUTH_SECRET`, an `Alchemy.Random` per stage that only `auth` reads. It keeps no
 * `workers.dev` address, domain or route. The D1 binding is made by the Worker's own program.
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
  const subdomain = yield* Config.String("CLOUDFLARE_WORKERS_SUBDOMAIN").pipe(Config.option);
  const origin = yield* interimPublicOrigin({ stack, stage, subdomain });
  const methods = yield* Schema.encodeEffect(Schema.fromJsonString(AuthMethods))(METHODS);
  const main = yield* path.fromFileUrl(new URL("../../apps/auth/src/worker.ts", import.meta.url));

  const props = {
    compatibility: { date: compat.date, flags: compat.flags.map((flag) => flag.name) },
    env: {
      AUTH_COOKIE_CACHE_MAX_AGE_S: values.AUTH_COOKIE_CACHE_MAX_AGE_S,
      AUTH_COOKIE_CACHE_STRATEGY: values.AUTH_COOKIE_CACHE_STRATEGY,
      AUTH_METHODS: methods,
      BETTER_AUTH_SECRET: secret.text,
      LOG_LEVEL: values.LOG_LEVEL,
      PUBLIC_ORIGIN: origin,
    },
    main,
    name: yield* workerName({ stack, stage, worker: "auth" }),
    workersDev: false,
  } satisfies Cloudflare.WorkerProps;

  return yield* Auth.pipe(
    Effect.provide(AuthWorker.pipe(Layer.provide(Layer.succeed(AuthDeployment, { props })))),
  );
});
