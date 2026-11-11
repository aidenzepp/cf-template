import { Layer } from "effect";
import { KnobsKvLive } from "@workspace/knobs-kv/live";

/**
 * The attach file of `web`. `web` has no Worker program, so its runtime provides the layer when
 * one does.
 */
export const WebLayers = Layer.mergeAll(
  // block:knobs-kv start
  KnobsKvLive,
  // block:knobs-kv end
);
