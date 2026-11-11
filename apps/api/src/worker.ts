import * as Cloudflare from "@alchemy.run/cloudflare";
import { RuntimeContext } from "alchemy";
import type { InputProps } from "alchemy/Input";
import type { MainRpc } from "alchemy/Platform";
import * as Http from "alchemy/Http";
import { Context, Effect, Layer, Option } from "effect";
import { HttpRouter } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import type { Auth } from "@workspace/auth/contract";
import { Api } from "@workspace/contract/api/api";
import { ProblemDetailsIncludeKnob } from "./config.ts";
import { AuthCheckSession, SessionLookup, SessionMiddlewareLive } from "./authorization.ts";
import { ExampleFeatureGateLive } from "./notes/gate.ts";
import { NotesApiHandlersNoDeps } from "./notes/http.ts";
import { Notes } from "./notes/notes.ts";
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
 * What `infra` supplies to the `api` Worker: its deploy properties and the `auth` Worker it binds.
 * The Worker module never declares either, so the stage, the name and the bindings have one owner,
 * `infra/src/api.ts`.
 */
export class ApiDeployment extends Context.Service<
  ApiDeployment,
  {
    readonly auth: Effect.Success<typeof Auth>;
    readonly props: InputProps<Cloudflare.WorkerProps>;
  }
>()("@workspace/api/ApiDeployment") {}

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
 * The `api` Worker: the contract's `HttpApi` over the in-memory notes, the session middleware that
 * asks `auth` through its service binding, the example-feature gate, and Problem Details on every
 * error it produces. It has no public address; `web` forwards `/api/*` to it.
 *
 * `PROBLEM_DETAILS_INCLUDE` is read once when the Worker starts, so a bad value fails the start
 * instead of a request.
 */
export default ApiWorker.make(
  ApiDeployment.pipe(Effect.map(({ props }) => props)),
  Effect.gen(function* buildApi() {
    const { auth } = yield* ApiDeployment;
    const authBinding = yield* Cloudflare.bindWorker(auth);
    const includeDetails = yield* ProblemDetailsIncludeKnob.config;

    const sessions = SessionLookup.layer.pipe(
      Layer.provide(
        Layer.succeed(AuthCheckSession, (input) =>
          withHostContext(authBinding.checkSession(input)),
        ),
      ),
    );

    const handlers = Layer.mergeAll(NotesApiHandlersNoDeps, SystemApiHandlers).pipe(
      Layer.provide(Notes.layerMemory),
    );

    const routes = HttpApiBuilder.layer(Api).pipe(
      Layer.provide(handlers),
      Layer.provide([SessionMiddlewareLive, ExampleFeatureGateLive]),
      Layer.provide(sessions),
      Layer.provide(layerProblemDetails({ includeDetails })),
      Layer.provide(Http.Platform),
      Layer.merge(ProblemAdapter),
    );

    return { fetch: yield* HttpRouter.toHttpEffect(routes) };
  }),
);
