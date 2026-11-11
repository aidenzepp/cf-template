import * as Cloudflare from "@alchemy.run/cloudflare";
import { RuntimeContext, Telemetry as AlchemyTelemetry } from "alchemy";
import { makeExecutionMemo } from "alchemy/Runtime/ExecutionMemo";
import type { InputProps } from "alchemy/Input";
import type { MainRpc } from "alchemy/Platform";
import * as Http from "alchemy/Http";
import { ConfigProvider, Context, Effect, Layer, Logger, Option } from "effect";
import { HttpRouter } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { Auth } from "@workspace/auth/contract";
import { Api } from "@workspace/contract/api/api";
import { makeDatabase } from "@workspace/db/database";
import { ProblemDetailsIncludeKnob } from "./config.ts";
import { AuthCheckSession, SessionLookup, SessionMiddlewareLive } from "./authorization.ts";
import { ExampleFeatureGateLive } from "./notes/gate.ts";
import { NotesApiHandlersNoDeps } from "./notes/http.ts";
import { Notes, NotesDatabase } from "./notes/notes.ts";
import type { NotesService } from "./notes/notes.ts";
import { ProblemAdapter, layerProblemDetails } from "./problem-details.ts";
import { SystemApiHandlers } from "./system.ts";

/**
 * Run a call on the `auth` binding with the host context of the request in progress.
 *
 * The binding's methods are typed with `RuntimeContext` because `auth` implements them with it; the
 * stub only forwards the call over the service binding and never reads it. The middleware cannot
 * name that requirement, so this hands it the context the Worker's fetch fiber already holds, and
 * a fiber without one is a defect rather than an anonymous caller.
 *
 * @param call - The call on the binding.
 * @returns The call with `RuntimeContext` taken from the current fiber.
 */
const withHostContext = <A, E>(call: Effect.Effect<A, E, RuntimeContext>): Effect.Effect<A, E> =>
  Effect.contextWith((context) =>
    Option.match(Context.getOption(context, RuntimeContext), {
      onNone: () => Effect.die("The request fiber carries no RuntimeContext."),
      onSome: (host) => Effect.provideService(call, RuntimeContext, host),
    }),
  );

/**
 * What `infra` supplies to the `api` Worker when it plans: its deploy properties. The Worker module
 * never declares them, so the stage, the name and the knobs have one owner, `infra/src/api.ts`.
 *
 * The deployed bundle evaluates the same module with no provider, so the properties are optional
 * there and ignored: the Worker is already deployed. Nothing the running Worker needs comes from
 * this service; it reaches `auth` through the binding Alchemy delivers to it.
 */
export class ApiDeployment extends Context.Service<
  ApiDeployment,
  {
    readonly props: InputProps<Cloudflare.WorkerProps>;
    readonly telemetry: Cloudflare.CloudflareTelemetryProps;
  }
>()("@workspace/api/ApiDeployment") {}

/**
 * The deploy properties of the `api` Worker: `infra`'s when it plans, none in the deployed bundle.
 */
export const apiProps = Effect.serviceOption(ApiDeployment).pipe(
  Effect.map(Option.match({ onNone: () => ({}), onSome: ({ props }) => props })),
);

/**
 * The tracing options of the `api` Worker: `infra`'s when it plans, none in the deployed bundle,
 * where the tracing layer ignores them because the Worker is already deployed.
 */
export const apiTelemetry = Effect.serviceOption(ApiDeployment).pipe(
  Effect.map(Option.match({ onNone: () => ({}), onSome: ({ telemetry }) => telemetry })),
);

/**
 * Cloudflare traces for the Worker's spans, and structured JSON logs that reach `console.error`,
 * `console.warn` and the rest at their own level, registered once for every event of the Worker.
 */
export const apiObservability = Layer.unwrap(
  apiTelemetry.pipe(
    Effect.map((options) =>
      Layer.mergeAll(
        Cloudflare.Telemetry(options),
        AlchemyTelemetry.layer(Logger.layer([Logger.withLeveledConsole(Logger.formatStructured)])),
      ),
    ),
  ),
);

/**
 * The entrypoint of the `api` Worker: it exposes no RPC method, and its `fetch` is the program's
 * own.
 */
export interface ApiEntrypoint extends MainRpc<RuntimeContext> {
  readonly fetch: Http.HttpEffect;
}

/**
 * The tag of the `api` Worker. `Api` names the contract's `HttpApi`, so this class carries the
 * Worker's logical id under its own name.
 */
export class ApiWorker extends Cloudflare.Worker<ApiWorker, ApiEntrypoint>()("Api") {}

/**
 * Build the request handler of one execution from the Worker's own bindings.
 *
 * The three knobs are read from `WorkerEnvironment` when an execution starts, never through the
 * deployer's `Config` while the stack plans: Alchemy resolves a `Config` read in Worker init
 * against the deployer's environment and binds that value over the one `infra` binds per stage. A
 * missing or invalid binding is a defect of that execution's requests and nothing else.
 *
 * The notes service is not built here: it holds the store, so it is built once per isolate and
 * shared by every execution; a store built per execution would be empty on every request.
 *
 * @param checkSession - The `checkSession` method of the bound `auth` Worker.
 * @param notes - The notes service of the isolate.
 * @returns The router's HTTP effect, built on the execution scope.
 */
export const makeHandler = (checkSession: typeof AuthCheckSession.Service, notes: NotesService) =>
  Effect.gen(function* buildHandler() {
    const env = yield* Cloudflare.WorkerEnvironment;
    const provider = ConfigProvider.layer(ConfigProvider.fromUnknown(env));

    const includeDetails = yield* ProblemDetailsIncludeKnob.config.pipe(Effect.provide(provider));

    const sessions = SessionLookup.layer.pipe(
      Layer.provide(Layer.succeed(AuthCheckSession, checkSession)),
    );

    const handlers = Layer.mergeAll(NotesApiHandlersNoDeps, SystemApiHandlers).pipe(
      Layer.provide(Layer.succeed(Notes, notes)),
    );

    const routes = HttpApiBuilder.layer(Api).pipe(
      Layer.provide(handlers),
      Layer.provide([SessionMiddlewareLive, ExampleFeatureGateLive]),
      Layer.provide(sessions),
      Layer.provide(layerProblemDetails({ includeDetails })),
      Layer.provide(Http.Platform),
      Layer.merge(ProblemAdapter),
      Layer.provide(provider),
    );

    return yield* HttpRouter.toHttpEffect(routes);
  });

/**
 * The `api` Worker: the contract's `HttpApi` over the notes in the app D1 database, the session
 * middleware that asks `auth` through its service binding, the example-feature gate, and Problem
 * Details on every error it produces. It has no public address; `web` forwards `/api/*` to it.
 *
 * Initialization binds `auth` and the `AppDb` database, reads no setting and builds the notes
 * service once for the isolate; the database client is built on first use in each execution, and
 * so is the handler, which reads the knobs.
 */
export default ApiWorker.make(
  apiProps,
  Effect.gen(function* buildApi() {
    const authBinding = yield* Cloudflare.bindWorker(Auth);
    const context = yield* Effect.context<Cloudflare.WorkerEnvironment>();
    // Declared by `infra` under this id; the deployed Worker only needs the id to find its binding.
    const appDb = yield* Cloudflare.D1.Database("AppDb");

    const appBinding = yield* Cloudflare.D1.QueryDatabase(appDb).pipe(
      Effect.provide(Cloudflare.D1.QueryDatabaseBinding),
    );

    const database = yield* makeExecutionMemo(
      Effect.gen(function* openAppDb() {
        const access = yield* makeDatabase(yield* appBinding.raw);

        return yield* access;
      }),
    );

    const notes = yield* Notes.pipe(
      Effect.provide(
        Notes.layer().pipe(
          Layer.provide(Layer.succeed(NotesDatabase, withHostContext(database).pipe(Effect.orDie))),
        ),
      ),
    );

    const handler = yield* makeExecutionMemo(
      makeHandler((input) => withHostContext(authBinding.checkSession(input)), notes).pipe(
        Effect.provideContext(context),
        Effect.orDie,
      ),
    );

    return { fetch: Effect.flatten(handler) };
  }).pipe(Effect.provide(apiObservability)),
);
