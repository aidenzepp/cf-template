import { Layer } from "effect";
import { SessionMiddlewareLive } from "./authorization.ts";
import { ExampleFeatureGateLive } from "./notes/gate.ts";
import { NotesApiHandlersNoDeps } from "./notes/http.ts";
import { NotesIsolateLive } from "./notes/isolate.ts";
import { SystemApiHandlers } from "./system/http.ts";

/**
 * The attach file of the `api` Worker: the handler groups it serves, the middleware they run
 * under, and the services built once per isolate, one entry per line. A removable unit appears in
 * this app only as an import and an entry here; `worker.ts` provides the layers and nothing else
 * imports this file.
 *
 * The lists stay separate because a group requires the middleware and the isolate services, which
 * a sibling in one `Layer.mergeAll` cannot supply. The attach grammar reads the call whether the
 * formatter keeps it on several lines or collapses it onto one.
 */
export const ApiWorkerHandlerGroupLayers = Layer.mergeAll(
  SystemApiHandlers,
  NotesApiHandlersNoDeps,
);

/**
 * The middleware layers of the `api` Worker; see {@link ApiWorkerHandlerGroupLayers}.
 */
export const ApiWorkerMiddlewareLayers = Layer.mergeAll(
  SessionMiddlewareLive,
  ExampleFeatureGateLive,
);

/**
 * No services: the entry that keeps {@link ApiWorkerIsolateLayers} a valid call when no unit adds
 * one.
 */
const NoIsolateServices = Layer.empty;

/**
 * The services the Worker builds once per isolate and every execution shares, over `AppDatabase`;
 * see {@link ApiWorkerHandlerGroupLayers}.
 */
export const ApiWorkerIsolateLayers = Layer.mergeAll(NoIsolateServices, NotesIsolateLive);
