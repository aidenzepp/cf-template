import { env } from "cloudflare:workers";
import { ManagedRuntime } from "effect";
import type { Effect } from "effect";
import { makeWebLayer } from "./web-layer.ts";

/**
 * The one runtime of `web`, built from the Worker's bindings on first use.
 */
const runtime = ManagedRuntime.make(makeWebLayer(env));

/**
 * Run an effect on the runtime of `web`. This is the only `Effect.run*` boundary in `apps/web`.
 *
 * @param effect - The effect to run.
 * @param options - The abort signal of the unit of work the effect belongs to.
 * @param options.signal - Interrupts the effect when aborted.
 * @returns A promise of the effect's success; a failure rejects it.
 */
export const run = <A, E>(
  effect: Effect.Effect<A, E, ManagedRuntime.ManagedRuntime.Services<typeof runtime>>,
  options?: { readonly signal?: AbortSignal },
): Promise<A> => runtime.runPromise(effect, options);
