import { Layer } from "effect";
import { KnobsKvLive } from "@workspace/knobs-kv/live";

/**
 * The attach file of the `auth` Worker: the services it builds once, as Layers, which `worker.ts`
 * provides.
 *
 * `KnobsKvLive` provides a `Context.Reference` with a default, so dropping it here is not a type
 * error: the Worker would read the deploy-time knob values. The `knobs-kv` attach test checks it.
 */
export const AuthLayers = Layer.mergeAll(KnobsKvLive);
