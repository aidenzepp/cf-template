import { Layer } from "effect";
import { KnobsKvLive } from "@workspace/knobs-kv/live";

/**
 * The attach file of the `auth` Worker. A block adds its import and one merged-layer entry per
 * line, and `worker.ts` provides the layer.
 */
export const AuthLayers = Layer.mergeAll(
  // block:knobs-kv start
  KnobsKvLive,
  // block:knobs-kv end
);
