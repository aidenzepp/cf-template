import * as Cloudflare from "@alchemy.run/cloudflare";
import { Telemetry as AlchemyTelemetry } from "alchemy";
import type { InputProps } from "alchemy/Input";
import { makeExecutionMemo } from "alchemy/Runtime/ExecutionMemo";
import { ConfigProvider, Context, Effect, Layer, Logger, Option } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { atLogLevel, liveLogLevel } from "@workspace/config/log-level";
import type { WorkerRequirements } from "@workspace/config/worker-requirements";
import { AuthService, authDatabaseLayer } from "./auth.ts";
import { AuthLayers } from "./blocks.ts";
import { Auth, AUTH_BASE_PATH } from "./contract.ts";
import { CheckSession } from "./session.ts";

/**
 * What `infra` supplies to the `auth` Worker when it plans: its deploy properties. The Worker
 * module never declares them, so the stage and the name have one owner, `infra/src/auth.ts`.
 *
 * The deployed bundle evaluates the same module with no provider, so the properties are optional
 * there and ignored: the Worker is already deployed. Nothing the running Worker needs comes from
 * this service; its D1 binding is the one Alchemy delivers to it.
 */
export class AuthDeployment extends Context.Service<
  AuthDeployment,
  {
    readonly props: InputProps<Cloudflare.WorkerProps>;
    readonly telemetry: Cloudflare.CloudflareTelemetryProps;
  }
>()("@workspace/auth/AuthDeployment") {}

/**
 * The deploy properties of the `auth` Worker: `infra`'s when it plans, none in the deployed bundle.
 */
export const authProps = Effect.serviceOption(AuthDeployment).pipe(
  Effect.map(Option.match({ onNone: () => ({}), onSome: ({ props }) => props })),
);

/**
 * The tracing options of the `auth` Worker: `infra`'s when it plans, none in the deployed bundle,
 * where the tracing layer ignores them because the Worker is already deployed.
 */
export const authTelemetry = Effect.serviceOption(AuthDeployment).pipe(
  Effect.map(Option.match({ onNone: () => ({}), onSome: ({ telemetry }) => telemetry })),
);

/**
 * Cloudflare traces for the Worker's spans, and structured JSON logs that reach `console.error`,
 * `console.warn` and the rest at their own level, registered once for every event of the Worker.
 */
const authObservability = Layer.unwrap(
  authTelemetry.pipe(
    Effect.map((options) =>
      Layer.mergeAll(
        Cloudflare.Telemetry(options),
        AlchemyTelemetry.layer(Logger.layer([Logger.withLeveledConsole(Logger.formatStructured)])),
      ),
    ),
  ),
);

/**
 * Build the function that runs an effect at the live `LOG_LEVEL`, once per execution.
 *
 * The level is read from the Worker's own bindings when an execution starts, never through the
 * deployer's `Config` while the stack plans, as `AuthSettings` is. The returned effect yields the
 * function; `fetch` and `checkSession` each run their request through it.
 *
 * @param providers - The services of {@link AuthLayers}, built once in Worker init.
 * @returns The per-execution accessor of the runner.
 */
export const makeAtLevel = Effect.fn("makeAtLevel")(function* makeAtLevel(
  providers: Layer.Layer<Layer.Success<typeof AuthLayers>>,
) {
  const context = yield* Effect.context<Cloudflare.WorkerEnvironment>();

  return yield* makeExecutionMemo(
    Effect.gen(function* bindLevel() {
      const env = yield* Cloudflare.WorkerEnvironment;
      const provider = ConfigProvider.layer(ConfigProvider.fromUnknown(env));

      const level = yield* liveLogLevel.pipe(
        Effect.provide(providers.pipe(Layer.provideMerge(provider))),
      );

      return atLogLevel(level);
    }).pipe(Effect.provideContext(context), Effect.orDie),
  );
});

/**
 * The `auth` Worker: Better Auth under `/auth` over the shared Effect D1 client, and
 * `checkSession` on the default entrypoint for `api`. It has no public address. Each request of
 * either entrypoint runs at the live `LOG_LEVEL`.
 */
export default Auth.make(
  authProps,
  Effect.gen(function* buildAuth() {
    // Declared by `infra` under this id; the deployed Worker only needs the id to find its binding.
    const database = yield* Cloudflare.D1.Database("AuthDb");

    // Bindings register at plan time, so the providers are built here, never per request.
    const providers = Layer.succeedContext(yield* Layer.build(AuthLayers));
    const atLevel = yield* makeAtLevel(providers);

    const binding = yield* Cloudflare.D1.QueryDatabase(database).pipe(
      Effect.provide(Cloudflare.D1.QueryDatabaseBinding),
    );

    const services = CheckSession.layer.pipe(
      Layer.provideMerge(AuthService.layer),
      Layer.provide(authDatabaseLayer(binding.raw)),
    );

    const { auth, checkSession } = yield* Effect.all({
      auth: AuthService,
      checkSession: CheckSession,
    }).pipe(Effect.provide(services));

    const route = Effect.gen(function* routeFetch() {
      const request = yield* HttpServerRequest.HttpServerRequest;

      return request.url.startsWith(AUTH_BASE_PATH)
        ? yield* (yield* auth).fetch
        : HttpServerResponse.empty({ status: 404 });
    });

    return {
      checkSession: (input: Parameters<typeof checkSession>[0]) =>
        atLevel.pipe(Effect.flatMap((run) => run(checkSession(input)))),
      // `web` forwards `/auth/*` wholesale, so the Worker serves nothing else over HTTP.
      fetch: atLevel.pipe(Effect.flatMap((run) => run(route))),
    };
  }).pipe(Effect.provide(authObservability), Effect.satisfiesServicesType<WorkerRequirements>()),
);
