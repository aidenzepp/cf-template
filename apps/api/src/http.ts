import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Http from "alchemy/Http";
import { ConfigProvider, Effect, Layer } from "effect";
import type { Context } from "effect";
import { HttpRouter } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { Api } from "@workspace/contract/api/api";
import { atLogLevel, liveLogLevel } from "@workspace/config/log-level";
import { ProblemDetailsIncludeKnob } from "./config.ts";
import { AuthCheckSession, SessionLookup } from "./authorization.ts";
import type { ApiBlockProviders, ApiWorkerIsolateLayers } from "./blocks.ts";
import { ApiWorkerHandlerGroupLayers, ApiWorkerMiddlewareLayers } from "./blocks.ts";
import { ApiDocsRoutes } from "./docs/routes.ts";
import { ProblemAdapter, layerProblemDetails } from "./problem-details.ts";

/**
 * The services built once per isolate, as the isolate layers of `blocks.ts` provide them.
 */
export type ApiIsolateServices = Layer.Success<typeof ApiWorkerIsolateLayers>;

/**
 * Build the request handler of one execution from the Worker's own bindings.
 *
 * The three knobs are read from `WorkerEnvironment` when an execution starts, never through the
 * deployer's `Config` while the stack plans: Alchemy resolves a `Config` read in Worker init
 * against the deployer's environment and binds that value over the one `infra` binds per stage. A
 * missing or invalid binding is a defect of that execution's requests and nothing else.
 *
 * The returned effect runs each request at the live `LOG_LEVEL`, read once per request through the
 * `LiveKnobs` port. The documentation routes (`ApiDocsRoutes`) read `API_DOCS_ENABLED` the same
 * way, once per request to one of them.
 *
 * The isolate services are not built here: they hold state such as a store, so they are built once
 * per isolate and shared by every execution; a store built per execution would be empty on every
 * request.
 *
 * @param checkSession - The `checkSession` method of the bound `auth` Worker.
 * @param isolate - The services of the isolate, built from `ApiWorkerIsolateLayers`.
 * @param providers - The services of {@link ApiBlockProviders}, built once in Worker init; they are
 *   provided beneath the session lookup, the middleware and the handlers.
 * @returns The router's HTTP effect, built on the execution scope.
 */
export const makeHandler = (
  checkSession: typeof AuthCheckSession.Service,
  isolate: Context.Context<ApiIsolateServices>,
  providers: Layer.Layer<Layer.Success<typeof ApiBlockProviders>>,
) =>
  Effect.gen(function* buildHandler() {
    const env = yield* Cloudflare.WorkerEnvironment;
    const provider = ConfigProvider.layer(ConfigProvider.fromUnknown(env));

    const includeDetails = yield* ProblemDetailsIncludeKnob.config.pipe(Effect.provide(provider));

    const sessions = SessionLookup.layer.pipe(
      Layer.provide(Layer.succeed(AuthCheckSession, checkSession)),
    );

    const handlers = ApiWorkerHandlerGroupLayers.pipe(Layer.provide(Layer.succeedContext(isolate)));

    const routes = HttpApiBuilder.layer(Api).pipe(
      Layer.provide(handlers),
      Layer.provide(ApiWorkerMiddlewareLayers),
      Layer.provide(sessions),
      Layer.provide(providers),
      Layer.provide(layerProblemDetails({ includeDetails })),
      Layer.provide(Http.Platform),
      Layer.merge(ProblemAdapter),
      Layer.merge(ApiDocsRoutes.pipe(Layer.provide(providers))),
      Layer.provide(provider),
    );

    const atLevel = atLogLevel(
      yield* liveLogLevel.pipe(Effect.provide(providers), Effect.provide(provider)),
    );

    return atLevel(yield* HttpRouter.toHttpEffect(routes));
  });
