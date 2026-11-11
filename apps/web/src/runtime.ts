import { env } from "cloudflare:workers";
import { createIsomorphicFn } from "@tanstack/react-start";
import { Layer, ManagedRuntime } from "effect";
import { AtomRegistry } from "effect/reactivity";
import type { Effect } from "effect";
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
 * The one runtime of `web`, built on first use so the browser reads the hydrated text.
 */
const makeRuntime = () =>
  ManagedRuntime.make(
    Layer.mergeAll(
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

  return runtime.runPromise(effect, options);
};
