import { Layer } from "effect";

/**
 * The attach file of the `auth` Worker. No unit attaches here yet; a block adds its import and one
 * merged-layer entry per line, and `worker.ts` provides the layer.
 */
export const AuthLayers = Layer.empty;
