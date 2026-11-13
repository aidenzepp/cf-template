import { Layer } from "effect";
import { KnobsKvLive } from "@workspace/knobs-kv/live";
import { SystemApiHandlers } from "./system/http.ts";

/**
 * The attach file of the `api` Worker: the handler groups it serves and the services it builds
 * once, as Layers. `worker.ts` provides them and nothing else imports this file.
 *
 * The lists stay separate because a group requires the isolate services, which a sibling in one
 * `Layer.mergeAll` cannot supply.
 */
export const ApiWorkerHandlerGroupLayers = Layer.mergeAll(SystemApiHandlers);

/**
 * The provider layers of the `api` Worker: services the handlers read but never build, such as the
 * live-knobs adapter. `worker.ts` builds this list once in Worker init, where bindings are
 * registered, and provides the result beneath the other lists.
 *
 * `KnobsKvLive` provides a `Context.Reference` with a default, so dropping it here is not a type
 * error: the Worker would read the deploy-time knob values. The `knobs-kv` attach test checks it.
 */
export const ApiBlockProviders = Layer.mergeAll(KnobsKvLive);

/**
 * The services the Worker builds once per isolate and every execution shares, over `AppDatabase`;
 * none today.
 */
export const ApiWorkerIsolateLayers = Layer.empty;
