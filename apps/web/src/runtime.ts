import { env } from "cloudflare:workers";
import { createIsomorphicFn } from "@tanstack/react-start";
import { Effect, Layer, Logger, ManagedRuntime } from "effect";
import { AtomRegistry } from "effect/reactivity";
import { ApiClient } from "./api-client.ts";
import { makeOrphanGraceLayer, makeWebLayer } from "./web-layer.ts";

/**
 * The `AUTH_METHODS` text the server handed to the browser through the router's dehydrated state.
 */
let hydratedAuthMethods = "";

/**
 * The `AUTH_ORPHAN_GRACE_SECONDS` text the server handed to the browser the same way.
 */
let hydratedOrphanGrace = "";

/**
 * The `AUTH_METHODS` text of this environment: the Worker's binding on the server, the hydrated
 * copy in the browser. An empty copy fails the decode; there is no fallback value.
 */
export const authMethodsText = createIsomorphicFn()
  .server(() => env.AUTH_METHODS)
  .client(() => hydratedAuthMethods);

/**
 * The `AUTH_ORPHAN_GRACE_SECONDS` text of this environment: the Worker's binding on the server, the
 * hydrated copy in the browser.
 */
export const orphanGraceText = createIsomorphicFn()
  .server(() => env.AUTH_ORPHAN_GRACE_SECONDS)
  .client(() => hydratedOrphanGrace);

/**
 * Remember the `AUTH_ORPHAN_GRACE_SECONDS` text the server dehydrated, before the browser's runtime
 * is built.
 *
 * @param text - The text `infra` bound.
 */
export const hydrateOrphanGrace = (text: string): void => {
  hydratedOrphanGrace = text;
};

/**
 * Remember the `AUTH_METHODS` text the server dehydrated, before the browser's runtime is built.
 *
 * @param text - The JSON text `infra` bound.
 */
export const hydrateAuthMethods = (text: string): void => {
  hydratedAuthMethods = text;
};

/**
 * Structured JSON logs that reach `console.error`, `console.warn` and the rest at their own level.
 *
 * `web` is a `Website.Vite` Worker with no Alchemy init effect, so `Cloudflare.Telemetry` has no
 * Worker to bind to here: its Effect spans stay local and Cloudflare's own spans come from the
 * `observability.traces` prop `infra/src/web.ts` sets.
 */
export const structuredLogs = Logger.layer([Logger.withLeveledConsole(Logger.formatStructured)]);

/**
 * The one runtime of `web`, built on first use so the browser reads the hydrated text.
 */
const makeRuntime = () =>
  ManagedRuntime.make(
    Layer.mergeAll(
      structuredLogs,
      makeWebLayer({ AUTH_METHODS: authMethodsText() }),
      makeOrphanGraceLayer({ AUTH_ORPHAN_GRACE_SECONDS: orphanGraceText() }),
      AtomRegistry.make().get(ApiClient.runtime.layer),
    ),
  );

let runtime: ReturnType<typeof makeRuntime> | undefined;

/**
 * Run an effect on the runtime of `web`. This is the only `Effect.run*` boundary in `apps/web`.
 *
 * @param effect - The effect to run.
 * @param options - The abort signal of the unit of work the effect belongs to.
 * @param options.signal - Interrupts the effect when aborted.
 * @returns A promise of the effect's success; a failure rejects it.
 */
export const run = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    ManagedRuntime.ManagedRuntime.Services<ReturnType<typeof makeRuntime>>
  >,
  options?: { readonly signal?: AbortSignal },
): Promise<A> => {
  runtime ??= makeRuntime();

  // A defect that is not an `Error` (a string passed to `die`) would reject with that bare value,
  // which the router dehydrates as it is. An `Error` goes through the router's hidden-error adapter.
  return runtime.runPromise(
    effect.pipe(
      Effect.catchDefect((defect) =>
        Effect.die(defect instanceof Error ? defect : new Error("Unexpected defect")),
      ),
    ),
    options,
  );
};
