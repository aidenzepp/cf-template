import { Layer } from "effect";
import { KnobsKvLive } from "@workspace/knobs-kv/live";
import { SessionMiddlewareLive } from "./authorization.ts";
import { ExampleFeatureGateLive } from "./notes/gate.ts";
import { NotesApiHandlersNoDeps } from "./notes/http.ts";
import { SystemApiHandlers } from "./system/http.ts";

/**
 * The attach file of the `api` Worker: the handler groups it serves and the middleware they run
 * under, one entry per line. A removable unit appears in this app only as an import and an entry
 * here; `worker.ts` provides both layers and nothing else imports this file.
 *
 * The two lists stay separate because a group requires the middleware, which a sibling in one
 * `Layer.mergeAll` cannot supply. The long names keep each call past the formatter's line width:
 * a shorter list would be collapsed onto one line, which the attach grammar rejects.
 */
export const ApiWorkerHandlerGroupLayers = Layer.mergeAll(
  SystemApiHandlers,
  NotesApiHandlersNoDeps,
);

/**
 * The middleware layers of the `api` Worker; see {@link ApiWorkerHandlerGroupLayers}.
 */
export const ApiWorkerMiddlewareLayers = Layer.mergeAll(
  // block:knobs-kv
  KnobsKvLive,
  SessionMiddlewareLive,
  ExampleFeatureGateLive,
);
