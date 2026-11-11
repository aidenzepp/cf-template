import { Layer } from "effect";

/**
 * The attach file of `web`. No unit attaches here yet; `web` has no Worker program, so its runtime
 * provides the layer when one does.
 */
export const WebLayers = Layer.empty;
