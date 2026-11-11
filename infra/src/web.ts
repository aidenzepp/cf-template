import * as Cloudflare from "@alchemy.run/cloudflare";
import { Effect, Path } from "effect";
import { AUTH_PASSWORD_SCRYPT } from "@workspace/config/auth-password";
import { limitKnobs, limitsFor } from "@workspace/config/limits";
import type { Auth } from "../../apps/auth/src/contract.ts";
import type { ApiWorker } from "../../apps/api/src/worker.ts";
import type { WebEnv } from "../../apps/web/src/env.ts";
import { FORWARD_PREFIXES } from "../../apps/web/src/forward-prefixes.ts";
import { namespaceId } from "../../apps/web/src/ratelimit.ts";
import { kindOf, workerName } from "../stages.ts";
import type { StageName } from "../stages.ts";
import { encodedAuthMethods, encodedOrphanGrace } from "./auth.ts";
import { compat } from "./compat.ts";
import { domainFor } from "./domain.ts";
import type { publicOrigin } from "./origin.ts";
import { webObservability } from "./telemetry.ts";

/**
 * The bindings of `web`: the two Workers it forwards to and the two values `apps/web` reads. Every
 * key is a key of `WebEnv`, the type `apps/web` reads its bindings by.
 */
interface WebBindings extends Record<keyof WebEnv, string | object> {
  readonly API: Effect.Success<typeof ApiWorker>;
  readonly AUTH: Effect.Success<typeof Auth>;
  readonly AUTH_METHODS: string;
  readonly AUTH_ORPHAN_GRACE_SECONDS: string;
  readonly PUBLIC_ORIGIN: string;
  readonly RATELIMIT_CREDENTIAL: object;
  readonly RATELIMIT_PUBLIC: object;
}

/**
 * Declare the `web` Worker with `Cloudflare.Website.Vite`, and under the `local` stage kind the
 * `WebProd` harness Worker.
 *
 * `web` is the only Worker with an address. It binds `api` as `API` and `auth` as `AUTH`, both as
 * plain service bindings that `apps/web` only ever calls `fetch` on, plus `AUTH_METHODS` and
 * `PUBLIC_ORIGIN` from the values `auth` already receives. `runWorkerFirst` is the same
 * {@link FORWARD_PREFIXES} constant the server entry forwards by, so a static asset never shadows
 * `/api/*` or `/auth/*`. `WebProd` serves the production bundle that `build:prod-harness` writes to
 * `apps/web/dist` and is never declared on any other stage kind.
 *
 * @param identity - The stack name and decoded stage.
 * @param identity.stack - The stack name from `resolveStackName`.
 * @param identity.stage - The decoded stage.
 * @param workers - The declared `api` and `auth` Workers that `web` binds.
 * @param workers.api - The `api` Worker resource.
 * @param workers.auth - The `auth` Worker resource.
 * @param origin - The stage's public origin, the same value `auth` receives.
 * @returns The `web` Worker resource.
 */
export const declareWeb = Effect.fn("declareWeb")(function* declareWeb(
  identity: { readonly stack: string; readonly stage: StageName },
  workers: {
    readonly api: Effect.Success<typeof ApiWorker>;
    readonly auth: Effect.Success<typeof Auth>;
  },
  origin: Effect.Success<ReturnType<typeof publicOrigin>>,
) {
  const { stack, stage } = identity;
  const path = yield* Path.Path;
  const methods = yield* encodedAuthMethods;
  const grace = yield* encodedOrphanGrace;
  const knobs = yield* limitKnobs;
  const compatibility = { date: compat.date, flags: compat.flags.map((flag) => flag.name) };

  const env = {
    API: workers.api,
    AUTH: workers.auth,
    AUTH_METHODS: methods,
    AUTH_ORPHAN_GRACE_SECONDS: grace,
    PUBLIC_ORIGIN: origin,
    RATELIMIT_CREDENTIAL: Cloudflare.RateLimit("RATELIMIT_CREDENTIAL", {
      namespaceId: namespaceId(stack, stage, "credential"),
      simple: { limit: 5, period: 60 },
    }),
    RATELIMIT_PUBLIC: Cloudflare.RateLimit("RATELIMIT_PUBLIC", {
      namespaceId: namespaceId(stack, stage, "public"),
      simple: { limit: 100, period: 10 },
    }),
  } satisfies WebBindings;

  const domain = yield* domainFor(stage);

  const web = yield* Cloudflare.Website.Vite("Web", {
    assets: { runWorkerFirst: [...FORWARD_PREFIXES] },
    compatibility,
    domain: domain.domain,
    env,
    limits: limitsFor("web", { ...knobs, scrypt: AUTH_PASSWORD_SCRYPT.default }),
    name: yield* workerName({ stack, stage, worker: "web" }),
    observability: webObservability(stage),
    rootDir: "apps/web",
    workersDev: domain.workersDev,
  });

  if (kindOf(stage) === "local") {
    const dist = yield* path.fromFileUrl(new URL("../../apps/web/dist/", import.meta.url));

    yield* Cloudflare.Worker("WebProd", {
      assets: { directory: path.join(dist, "client"), runWorkerFirst: [...FORWARD_PREFIXES] },
      compatibility,
      env,
      main: path.join(dist, "server", "server.js"),
      name: yield* workerName({ stack, stage, worker: "web-prod" }),
      workersDev: false,
    });
  }

  return web;
});
