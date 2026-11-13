import { Layer } from "effect";
import { KnobsKvLive } from "@workspace/knobs-kv/live";

/**
 * The attach file of `web` for Layers that need a binding Alchemy registers. `web` has no Worker
 * program, so its runtime provides the layer when one does; no module imports it yet.
 *
 * `KnobsKvLive` provides a `Context.Reference` with a default, so dropping it here is not a type
 * error. The `knobs-kv` attach test checks it.
 *
 * @public
 */
export const WebLayers = Layer.mergeAll(KnobsKvLive);
