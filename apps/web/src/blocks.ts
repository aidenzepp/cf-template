import { Layer } from "effect";
import { KnobsKvLive } from "@workspace/knobs-kv/live";

/**
 * No services: the entry that keeps {@link WebLayers} a valid call when no unit adds one.
 */
const NoWebLayers = Layer.empty;

/**
 * The attach file of `web`. `web` has no Worker program, so its runtime provides the layer when
 * one does.
 */
export const WebLayers = Layer.mergeAll(
  NoWebLayers,
  // block:knobs-kv start
  KnobsKvLive,
  // block:knobs-kv end
);
