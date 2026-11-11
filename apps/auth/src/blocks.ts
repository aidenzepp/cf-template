import { Layer } from "effect";
import { KnobsKvLive } from "@workspace/knobs-kv/live";

/**
 * No services: the entry that keeps {@link AuthLayers} a valid call when no unit adds one.
 */
const NoAuthLayers = Layer.empty;

/**
 * The attach file of the `auth` Worker. A block adds its import and one merged-layer entry per
 * line, and `worker.ts` provides the layer.
 */
export const AuthLayers = Layer.mergeAll(
  NoAuthLayers,
  // block:knobs-kv start
  KnobsKvLive,
  // block:knobs-kv end
);
