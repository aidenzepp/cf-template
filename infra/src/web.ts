import * as Cloudflare from "@alchemy.run/cloudflare";
import { Effect, Path } from "effect";
import { AUTH_PASSWORD_SCRYPT } from "@workspace/config/auth-password";
import { limitKnobs, limitsFor } from "@workspace/config/limits";
import type { Auth } from "../../apps/auth/src/contract.ts";
import type { ApiWorker } from "../../apps/api/src/worker.ts";
import type { WebEnv } from "../../apps/web/src/env.ts";
import { FORWARD_PREFIXES } from "../../apps/web/src/forward-prefixes.ts";
import { namespaceId } from "../../apps/web/src/ratelimit.ts";
import { Stages, kindOf, workerName } from "../stages.ts";
import type { StageName } from "../stages.ts";
import { encodedAuthMethods, encodedOrphanGrace } from "./auth.ts";
import { compat } from "./compat.ts";
import { domainFor } from "./domain.ts";
import type { publicOrigin } from "./origin.ts";
import { customDomainVariable, guardRateLimitOwner, rateLimitRef } from "./rate-limit-owner.ts";
import { RateLimitEntrypointLive } from "./rate-limit-owner-live.ts";
import { webObservability } from "./telemetry.ts";

/**
 * The bindings of `web` that are always present: the two Workers it forwards to and the values
 * `apps/web` reads. Every key is a key of `WebEnv`, the type `apps/web` reads its bindings by,
 * except `KNOBS`, which a block adds through `blockBindings` and `WebEnv` declares optional.
 */
interface WebBindings extends Record<Exclude<keyof WebEnv, "KNOBS">, boolean | string | object> {
  readonly API: Effect.Success<typeof ApiWorker>;
  readonly AUTH: Effect.Success<typeof Auth>;
  readonly AUTH_METHODS: string;
  readonly AUTH_ORPHAN_GRACE_SECONDS: string;
  readonly DOCS_ENABLED: boolean;
  readonly DOCS_LIVE_READ: boolean;
  readonly PUBLIC_ORIGIN: string;
  readonly RATELIMIT_CREDENTIAL: object;
  readonly RATELIMIT_PUBLIC: object;
}

/**
 * The domain of `web` on a stage, after `guardRateLimitOwner` has accepted its zone.
 *
 * Only the hostname form reads the zone; the `workers.dev` default reads nothing from Cloudflare.
 * A refusal fails here, before `declareWeb` declares anything.
 *
 * @param identity - The stack name and decoded stage.
 * @param identity.stack - The stack name from `resolveStackName`.
 * @param identity.stage - The decoded stage.
 * @param entrypoint - The layer that reads the zone's rate-limit entrypoint; tests replace it.
 * @returns The stage's {@link DomainConfig}, or the guard's refusal.
 */
export const guardedDomain = Effect.fn("guardedDomain")(function* guardedDomain(
  identity: { readonly stack: string; readonly stage: StageName },
  entrypoint: typeof RateLimitEntrypointLive = RateLimitEntrypointLive,
) {
  const { stack, stage } = identity;
  const domain = yield* domainFor(stage);

  if (domain.kind === "hostname") {
    yield* guardRateLimitOwner(
      domain.hostname,
      rateLimitRef(stack, stage, domain.hostname),
      customDomainVariable(stage),
    ).pipe(Effect.provide(entrypoint));
  }

  return domain;
});

/**
 * Declare the `web` Worker with `Cloudflare.Website.Vite`, and under the `local` stage kind the
 * `WebProd` harness Worker.
 *
 * On a stage that attaches a hostname it first runs `guardRateLimitOwner`, so a zone whose
 * rate-limit entrypoint holds rules this stack did not create is refused before anything is
 * declared.
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
 * @param blockBindings - The plain bindings the blocks add to `web`'s env, as name and resource
 *   pairs; a block binds its own resource here from the attach file, so this module names none.
 * @param entrypoint - The layer that reads the zone's rate-limit entrypoint; tests replace it.
 * @returns The `web` Worker resource.
 */
export const declareWeb = Effect.fn("declareWeb")(function* declareWeb(
  identity: { readonly stack: string; readonly stage: StageName },
  workers: {
    readonly api: Effect.Success<typeof ApiWorker>;
    readonly auth: Effect.Success<typeof Auth>;
  },
  origin: Effect.Success<ReturnType<typeof publicOrigin>>,
  blockBindings: ReadonlyArray<readonly [name: string, binding: object]> = [],
  entrypoint: typeof RateLimitEntrypointLive = RateLimitEntrypointLive,
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
    DOCS_ENABLED: Stages[kindOf(stage)].DOCS_ENABLED,
    DOCS_LIVE_READ: kindOf(stage) !== "prod",
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

  const bindings = { ...env, ...Object.fromEntries(blockBindings) };

  const domain = yield* guardedDomain(identity, entrypoint);

  const web = yield* Cloudflare.Website.Vite("Web", {
    assets: { runWorkerFirst: [...FORWARD_PREFIXES] },
    compatibility,
    domain: domain.domain,
    env: bindings,
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
      env: bindings,
      main: path.join(dist, "server", "server.js"),
      name: yield* workerName({ stack, stage, worker: "web-prod" }),
      workersDev: false,
    });
  }

  return web;
});
